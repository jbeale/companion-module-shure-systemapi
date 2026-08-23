/**
 * Shure SystemAPI-compatible REST + WebSocket surface for the mock server.
 *
 * Implements the subset of SystemAPI v1.8 that the Companion module uses,
 * with the same URL shapes, auth header, paginated device list, subscription
 * handshake and event envelopes as the real server.
 */

import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

/**
 * Wire the Shure-compatible API onto an https server.
 *
 * @param {import('node:https').Server} server - the HTTPS server
 * @param {import('./state.js').SimState} state - simulation state
 * @param {Object} opts - { apiKey, listShape }
 * @returns {Object} handles for the caller
 */
export function attachApi(server, state, opts) {
	/** transportId -> { ws, subs:Set<string> } */
	const transports = new Map()

	// ---------------------------------------------------------------- events

	/**
	 * Deliver an event to every transport subscribed to `key`.
	 * @param {string} key - subscription key
	 * @param {Object} message - full event message
	 */
	function publish(key, message) {
		for (const t of transports.values()) {
			if (t.subs.has(key) && t.ws.readyState === 1) {
				t.ws.send(JSON.stringify(message))
			}
		}
	}

	state.on('event', (eventName, device, body) => {
		publish(`${device.deviceId}:${eventName}`, {
			envelope: { eventName: eventName, deviceId: device.deviceId },
			body: body,
		})
	})

	state.on('channel-event', (eventName, device, channel, body) => {
		publish(`${device.deviceId}:${channel.id}:${eventName}`, {
			envelope: { eventName: eventName, deviceId: device.deviceId, audioChannelId: channel.id },
			body: body,
		})
	})

	state.on('device-state-change', (device) => {
		publish('DEVICE_STATE_CHANGE', {
			envelope: { eventName: 'DEVICE_STATE_CHANGE', deviceId: device.deviceId },
			body: deviceNode(device),
		})
	})

	// ----------------------------------------------------------- serializers

	/**
	 * OnlineDevice / DiscoveredDevice node.
	 * @param {Object} d - device
	 * @returns {Object} node
	 */
	function deviceNode(d) {
		const node = {
			compatibility: d.compatibility,
			deviceState: d.deviceState,
			hardwareIdentity: { deviceId: d.deviceId, serialNumber: d.serialNumber },
			softwareIdentity: { firmwareVersion: d.firmwareVersion, model: d.model, firmwareValid: true },
			communicationProtocol: { name: 'ESTA.DMP', address: d.address },
			capabilities: d.capabilities,
		}
		if (d.deviceState === 'DISCOVERED') {
			// discovered devices carry a reduced identity
			delete node.hardwareIdentity.serialNumber
			delete node.softwareIdentity.firmwareVersion
			delete node.softwareIdentity.firmwareValid
			delete node.capabilities
		}
		return node
	}

	/**
	 * Device list, in the response shape selected by `--list-shape`.
	 * @returns {Object|Array} list payload
	 */
	function deviceList() {
		const nodes = state.list().map(deviceNode)

		if (opts.listShape === 'array') {
			return nodes
		}
		if (opts.listShape === 'items') {
			return { items: nodes }
		}
		// spec default: Relay-style pagination
		const edges = nodes.map((node) => ({
			cursor: Buffer.from(JSON.stringify({ f: 'D', a: node.hardwareIdentity.deviceId })).toString('base64'),
			node: node,
		}))
		return {
			pageInfo: {
				hasNextPage: false,
				hasPreviousPage: false,
				startCursor: edges[0]?.cursor ?? '',
				endCursor: edges[edges.length - 1]?.cursor ?? '',
			},
			edges: edges,
		}
	}

	/**
	 * AudioChannelList for a device.
	 * @param {Object} d - device
	 * @returns {Array} channels
	 */
	function channelList(d) {
		return d.channels.map((c) => ({
			id: c.id,
			role: c.role,
			group: c.group,
			capabilities: c.capabilities,
		}))
	}

	// -------------------------------------------------------------- routing

	/**
	 * Route one REST request.
	 *
	 * @param {string} method - HTTP method
	 * @param {string} path - path below /api
	 * @param {Object|null} body - parsed JSON body
	 * @returns {Object} { status, payload }
	 */
	function route(method, path, body) {
		const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
		// seg[0] === 'v1'
		if (seg[0] !== 'v1') return { status: 404, payload: { message: 'Not found' } }

		// /v1/devices
		if (seg.length === 2 && seg[1] === 'devices' && method === 'GET') {
			return { status: 200, payload: deviceList() }
		}

		// /v1/devices/subscription/{transportId}
		if (seg.length === 4 && seg[1] === 'devices' && seg[2] === 'subscription') {
			return subscribe(method, seg[3], 'DEVICE_STATE_CHANGE')
		}

		if (seg[1] !== 'devices' || seg.length < 3) {
			return { status: 404, payload: { message: 'Not found' } }
		}

		const device = state.get(seg[2])
		if (!device) return { status: 404, payload: { message: 'Device not found' } }

		const rest = seg.slice(3)

		// /v1/devices/{id}
		if (rest.length === 0 && method === 'GET') {
			return { status: 200, payload: deviceNode(device) }
		}

		// ---- audio channels -------------------------------------------------
		if (rest[0] === 'audio-channels') {
			if (rest.length === 1 && method === 'GET') {
				return { status: 200, payload: channelList(device) }
			}

			const channel = state.channel(device.deviceId, rest[1])
			if (!channel) return { status: 404, payload: { message: 'Channel not found' } }

			const prop = rest[2]
			const tail = rest.slice(3)

			// .../{prop}/subscription/{transportId}
			if (tail[0] === 'subscription' && tail[1]) {
				const eventName = {
					mute: 'AUDIO_CHANNEL_MUTE',
					gain: 'AUDIO_CHANNEL_GAIN',
					name: 'AUDIO_CHANNEL_NAME',
					activity: 'AUDIO_CHANNEL_ACTIVITY',
				}[prop]
				if (!eventName) return { status: 404, payload: { message: 'Not subscribable' } }
				return subscribe(method, tail[1], `${device.deviceId}:${channel.id}:${eventName}`)
			}

			// .../gain/description
			if (prop === 'gain' && tail[0] === 'description' && method === 'GET') {
				return { status: 200, payload: { constraints: { gain: { range: channel.gainRange } } } }
			}

			if (prop === 'mute') {
				if (method === 'GET') return { status: 200, payload: { muted: channel.muted } }
				if (method === 'PATCH') {
					state.setChannelField(device.deviceId, channel.id, 'muted', body?.muted)
					return { status: 204, payload: null }
				}
			}
			if (prop === 'gain') {
				if (method === 'GET') return { status: 200, payload: { gain: channel.gain } }
				if (method === 'PATCH') {
					state.setChannelField(device.deviceId, channel.id, 'gain', body?.gain)
					return { status: 204, payload: null }
				}
			}
			if (prop === 'name') {
				if (method === 'GET') return { status: 200, payload: { name: channel.name } }
				if (method === 'PATCH') {
					state.setChannelField(device.deviceId, channel.id, 'name', body?.name)
					return { status: 204, payload: null }
				}
			}
			if (prop === 'activity' && method === 'GET') {
				return { status: 200, payload: { audioLevel: channel.activity } }
			}

			return { status: 404, payload: { message: 'Not found' } }
		}

		// ---- device-level properties ---------------------------------------
		const prop = rest[0]
		const tail = rest.slice(1)

		if (tail[0] === 'subscription' && tail[1]) {
			const eventName = {
				name: 'DEVICE_NAME',
				identify: 'DEVICE_IDENTIFY',
				'audio-mute': 'DEVICE_AUDIO_MUTE',
				'battery-level': 'DEVICE_BATTERY_LEVEL',
				'battery-health': 'DEVICE_BATTERY_HEALTH',
			}[prop]
			if (!eventName) return { status: 404, payload: { message: 'Not subscribable' } }
			return subscribe(method, tail[1], `${device.deviceId}:${eventName}`)
		}

		if (prop === 'name') {
			if (method === 'GET') return { status: 200, payload: { name: device.name } }
			if (method === 'PATCH') {
				state.setDeviceField(device.deviceId, 'name', body?.name)
				return { status: 204, payload: null }
			}
		}

		if (prop === 'identify') {
			if (method === 'GET') return { status: 200, payload: { identifying: device.identifying } }
			if (method === 'POST' && tail[0] === 'start') {
				state.setDeviceField(device.deviceId, 'identifying', true)
				return { status: 204, payload: null }
			}
			if (method === 'POST' && tail[0] === 'stop') {
				state.setDeviceField(device.deviceId, 'identifying', false)
				return { status: 204, payload: null }
			}
		}

		if (prop === 'audio-mute') {
			if (!device.capabilities.includes('audio-mute')) {
				return { status: 405, payload: { message: 'Capability not supported' } }
			}
			if (method === 'GET') return { status: 200, payload: { muted: device.audioMute } }
			if (method === 'PATCH') {
				state.setDeviceField(device.deviceId, 'audioMute', body?.muted)
				return { status: 204, payload: null }
			}
		}

		if (prop === 'battery-level' && method === 'GET') {
			if (!device.battery) return { status: 405, payload: { message: 'Device has no battery' } }
			return { status: 200, payload: state.batteryLevelBody(device) }
		}

		if (prop === 'battery-health' && method === 'GET') {
			if (!device.battery) return { status: 405, payload: { message: 'Device has no battery' } }
			return { status: 200, payload: state.batteryHealthBody(device) }
		}

		if (prop === 'capabilities' && method === 'GET') {
			return { status: 200, payload: device.capabilities }
		}

		if (prop === 'reboot' && method === 'POST') {
			const d = state.get(device.deviceId)
			state.setDeviceField(d.deviceId, 'deviceState', 'OFFLINE')
			setTimeout(() => state.setDeviceField(d.deviceId, 'deviceState', 'ONLINE'), 4000)
			return { status: 204, payload: null }
		}

		return { status: 404, payload: { message: 'Not found' } }
	}

	/**
	 * Register or drop a subscription for a transport.
	 *
	 * @param {string} method - POST to add, DELETE to remove
	 * @param {string} transportId - websocket transport
	 * @param {string} key - subscription key
	 * @returns {Object} { status, payload }
	 */
	function subscribe(method, transportId, key) {
		const t = transports.get(transportId)
		if (!t) return { status: 404, payload: { message: 'Unknown transportId' } }

		if (method === 'POST') {
			t.subs.add(key)
			return { status: 204, payload: null }
		}
		if (method === 'DELETE') {
			t.subs.delete(key)
			return { status: 204, payload: null }
		}
		return { status: 405, payload: { message: 'Method not allowed' } }
	}

	// ----------------------------------------------------------- http plumbing

	/**
	 * Handle an /api request. Returns true if it consumed the request.
	 *
	 * @param {import('node:http').IncomingMessage} req
	 * @param {import('node:http').ServerResponse} res
	 * @returns {boolean} handled
	 */
	function handleRequest(req, res) {
		const url = new URL(req.url, 'https://localhost')
		if (!url.pathname.startsWith('/api/')) return false

		if (req.headers['x-api-key'] !== opts.apiKey) {
			res.writeHead(401, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ message: 'Invalid or missing x-api-key' }))
			return true
		}

		let raw = ''
		req.on('data', (c) => (raw += c))
		req.on('end', () => {
			let body = null
			if (raw.length) {
				try {
					body = JSON.parse(raw)
				} catch (_err) {
					res.writeHead(400, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify({ message: 'Malformed JSON' }))
					return
				}
			}

			let result
			try {
				result = route(req.method, url.pathname.slice('/api'.length), body)
			} catch (err) {
				result = { status: 500, payload: { message: err.message } }
			}

			if (result.status === 204 || result.payload === null) {
				res.writeHead(result.status)
				res.end()
			} else {
				res.writeHead(result.status, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(result.payload))
			}
		})
		return true
	}

	// ------------------------------------------------------------- websocket

	const wss = new WebSocketServer({ noServer: true })

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, 'https://localhost')
		if (url.pathname !== '/api/v1/subscriptions/websocket/create') {
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			const transportId = randomUUID()
			transports.set(transportId, { ws: ws, subs: new Set() })
			ws.send(JSON.stringify({ transportId: transportId }))
			ws.on('close', () => transports.delete(transportId))
		})
	})

	return { handleRequest, transports }
}
