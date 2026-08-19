import https from 'node:https'
import WebSocket from 'ws'
import { InstanceStatus } from '@companion-module/base'

/**
 * Client for the Shure SystemAPI Server (REST + WebSocket subscriptions).
 *
 * ADTQ/ADTD transmitters do not expose a direct TCP/REST interface; all
 * monitoring and control goes through Shure's SystemAPI Server middleware.
 * REST calls carry the shared secret in the `x-api-key` header. Realtime
 * updates arrive over a WebSocket that is bound to REST subscriptions via
 * a transportId.
 */
export default class SystemApiClient {
	/**
	 * @param {import('./index.js').default} instance - the module instance
	 */
	constructor(instance) {
		this.instance = instance

		this.ws = null
		this.transportId = null
		this.reconnectTimer = null
		this.refreshTimer = null
		this.destroyed = false

		this.device = {
			id: null,
			model: '',
			firmware: '',
			name: '',
			state: 'OFFLINE',
			compatibility: '',
			address: '',
			identifying: false,
			audioMute: false,
			capabilities: [],
		}
		// audioChannelId (base64 string) -> channel state object
		this.channels = new Map()
	}

	/**
	 * Start the client: find the device, load state, open the WebSocket.
	 * @param {Object} config - module config (host, port, apiKey, deviceMode, deviceId)
	 */
	async init(config) {
		this.config = config
		this.destroyed = false

		this.stopTimers()

		try {
			await this.refreshDevice()
			this.openWebSocket()

			// The capabilities array is not realtime; re-sync periodically as a safety net
			this.refreshTimer = setInterval(() => {
				this.refreshDevice().catch((err) => {
					this.instance.log('debug', `Periodic refresh failed: ${err.message}`)
				})
			}, 60000)
		} catch (err) {
			this.instance.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			this.instance.log('error', `SystemAPI connection failed: ${err.message}`)
			this.scheduleReconnect()
		}
	}

	/**
	 * Stop all sockets and timers.
	 */
	destroy() {
		this.destroyed = true
		this.stopTimers()

		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.close()
			this.ws = null
		}
	}

	stopTimers() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer)
			this.refreshTimer = null
		}
	}

	scheduleReconnect() {
		if (this.destroyed || this.reconnectTimer) {
			return
		}
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.init(this.config)
		}, 10000)
	}

	/**
	 * Perform a REST request against the SystemAPI Server.
	 *
	 * @param {string} method - HTTP method
	 * @param {string} path - path under /api (e.g. '/v1/devices')
	 * @param {Object} [body] - optional JSON body
	 * @returns {Promise<any>} parsed JSON response (or null for 204)
	 */
	request(method, path, body) {
		return new Promise((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body)

			const req = https.request(
				{
					host: this.config.host,
					port: this.config.port,
					path: `/api${path}`,
					method: method,
					// the server generates a self-signed certificate by default
					rejectUnauthorized: false,
					headers: {
						'x-api-key': this.config.apiKey,
						'Content-Type': 'application/json',
						...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
					},
					timeout: 5000,
				},
				(res) => {
					let data = ''
					res.on('data', (chunk) => (data += chunk))
					res.on('end', () => {
						if (res.statusCode >= 200 && res.statusCode < 300) {
							try {
								resolve(data.length > 0 ? JSON.parse(data) : null)
							} catch (_err) {
								resolve(null)
							}
						} else if (res.statusCode === 401 || res.statusCode === 403) {
							reject(new Error(`Authentication failed (HTTP ${res.statusCode}): check the API shared secret`))
						} else {
							reject(new Error(`HTTP ${res.statusCode} on ${method} ${path}: ${data}`))
						}
					})
				}
			)

			req.on('error', (err) => reject(err))
			req.on('timeout', () => req.destroy(new Error(`Request timeout on ${method} ${path}`)))

			if (payload !== undefined) {
				req.end(payload)
			} else {
				req.end()
			}
		})
	}

	/**
	 * Discover devices, pick the configured ADPSM transmitter, and load its state.
	 */
	async refreshDevice() {
		const devices = await this.request('GET', '/v1/devices')
		const list = Array.isArray(devices) ? devices : devices?.items ?? []

		const adpsm = list.filter((d) => ['ADTQ', 'ADTD'].includes(d.softwareIdentity?.model))

		for (const d of adpsm) {
			this.instance.log(
				'debug',
				`Found ${d.softwareIdentity.model} (${d.deviceState}) at ${d.communicationProtocol?.address} — deviceId ${d.hardwareIdentity?.deviceId}`
			)
		}

		let target
		if (this.config.deviceMode === 'id' && this.config.deviceId) {
			target = list.find((d) => d.hardwareIdentity?.deviceId?.toLowerCase() === this.config.deviceId.toLowerCase())
			if (!target) {
				throw new Error(`Device ${this.config.deviceId} not found on SystemAPI Server`)
			}
		} else {
			target = adpsm[0]
			if (!target) {
				throw new Error('No ADTQ/ADTD found on SystemAPI Server')
			}
		}

		const changedDevice = this.device.id !== target.hardwareIdentity.deviceId

		this.device.id = target.hardwareIdentity.deviceId
		this.device.model = target.softwareIdentity?.model ?? ''
		this.device.firmware = target.softwareIdentity?.firmwareVersion ?? ''
		this.device.state = target.deviceState ?? 'OFFLINE'
		this.device.compatibility = target.compatibility ?? ''
		this.device.address = target.communicationProtocol?.address ?? ''
		this.device.capabilities = target.capabilities ?? []

		if (this.device.state === 'ONLINE') {
			await this.loadDeviceState()
			this.instance.updateStatus(InstanceStatus.Ok)
		} else {
			this.instance.updateStatus(InstanceStatus.Connecting, `Device ${this.device.state}`)
		}

		this.instance.setVariableValues({
			device_id: this.device.id,
			model: this.device.model,
			firmware: this.device.firmware,
			device_state: this.device.state,
			ip_address: this.device.address,
		})
		this.instance.checkFeedbacks('device_online')

		if (changedDevice) {
			this.instance.log('info', `Controlling ${this.device.model} (${this.device.id})`)
		}
	}

	/**
	 * Load name, mute, identify and audio channel state for the selected device.
	 */
	async loadDeviceState() {
		const id = this.device.id
		const has = (cap) => this.device.capabilities.includes(cap)

		const results = await Promise.allSettled([
			has('name') ? this.request('GET', `/v1/devices/${id}/name`) : null,
			this.request('GET', `/v1/devices/${id}/identify`),
			has('audio-mute') ? this.request('GET', `/v1/devices/${id}/audio-mute`) : null,
			this.request('GET', `/v1/devices/${id}/audio-channels`),
		])

		const [name, identify, audioMute, audioChannels] = results.map((r) => (r.status === 'fulfilled' ? r.value : null))

		if (name) {
			this.device.name = name.name
		}
		if (identify) {
			this.device.identifying = identify.identifying === true
		}
		if (audioMute) {
			this.device.audioMute = audioMute.muted === true
		}

		if (audioChannels) {
			const list = Array.isArray(audioChannels) ? audioChannels : audioChannels?.items ?? []
			await this.loadChannels(list)
		}

		this.instance.setVariableValues({
			device_name: this.device.name,
			audio_mute: this.device.audioMute ? 'Muted' : 'Unmuted',
		})
		this.instance.checkFeedbacks('device_muted', 'identifying')
	}

	/**
	 * Build channel state from the audio-channels list and fetch per-channel data.
	 *
	 * @param {Array} list - AudioChannelList from the API
	 */
	async loadChannels(list) {
		const known = new Set()

		for (const ch of list) {
			// only surface channels the user can actually do something with
			if (!ch.capabilities.some((c) => ['mute', 'gain', 'name'].includes(c))) {
				continue
			}

			known.add(ch.id)

			let channel = this.channels.get(ch.id)
			if (!channel) {
				channel = {
					id: ch.id,
					index: this.decodeChannelIndex(ch.id),
					role: ch.role,
					group: ch.group,
					capabilities: ch.capabilities,
					name: '',
					muted: false,
					gain: null,
					gainRange: null,
				}
				this.channels.set(ch.id, channel)
			} else {
				channel.role = ch.role
				channel.group = ch.group
				channel.capabilities = ch.capabilities
			}

			const id = this.device.id
			const reqs = []
			reqs.push(
				channel.capabilities.includes('name')
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/name`)
					: null
			)
			reqs.push(
				channel.capabilities.includes('mute')
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/mute`)
					: null
			)
			reqs.push(
				channel.capabilities.includes('gain')
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/gain`)
					: null
			)
			reqs.push(
				channel.capabilities.includes('gain') && channel.gainRange === null
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/gain/description`)
					: null
			)

			const [name, mute, gain, gainDesc] = (await Promise.allSettled(reqs)).map((r) =>
				r.status === 'fulfilled' ? r.value : null
			)

			if (name) {
				channel.name = name.name
			}
			if (mute) {
				channel.muted = mute.muted === true
			}
			if (gain) {
				channel.gain = gain.gain
			}
			if (gainDesc?.constraints?.gain?.range) {
				channel.gainRange = gainDesc.constraints.gain.range
			}
		}

		// drop channels that disappeared (e.g. channel count change)
		for (const id of this.channels.keys()) {
			if (!known.has(id)) {
				this.channels.delete(id)
			}
		}

		this.instance.rebuildChannelData()
	}

	/**
	 * The audioChannelId is base64-encoded JSON that includes the channel index.
	 * Decode it so channels can be sorted and labeled deterministically.
	 *
	 * @param {string} channelId - opaque audio channel id
	 * @returns {number} channel index, or -1 when it cannot be decoded
	 */
	decodeChannelIndex(channelId) {
		try {
			const decoded = JSON.parse(Buffer.from(channelId, 'base64').toString('utf8'))
			return typeof decoded.index === 'number' ? decoded.index : -1
		} catch (_err) {
			return -1
		}
	}

	/**
	 * Channels sorted by their decoded index.
	 * @returns {Array} channel state objects
	 */
	getChannels() {
		return [...this.channels.values()].sort((a, b) => a.index - b.index)
	}

	/**
	 * Open the realtime WebSocket and subscribe to events once the
	 * transportId is announced.
	 */
	openWebSocket() {
		if (this.destroyed) {
			return
		}

		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.close()
		}

		this.ws = new WebSocket(`wss://${this.config.host}:${this.config.port}/api/v1/subscriptions/websocket/create`, {
			rejectUnauthorized: false,
		})

		this.ws.on('message', (raw) => {
			let msg
			try {
				msg = JSON.parse(raw.toString())
			} catch (_err) {
				return
			}

			if (msg.transportId) {
				this.transportId = msg.transportId
				this.subscribeAll().catch((err) => {
					this.instance.log('error', `Subscription setup failed: ${err.message}`)
				})
				return
			}

			if (msg.envelope) {
				this.processEvent(msg)
			}
		})

		this.ws.on('close', () => {
			this.transportId = null
			if (!this.destroyed) {
				this.instance.updateStatus(InstanceStatus.Disconnected, 'WebSocket closed')
				this.scheduleReconnect()
			}
		})

		this.ws.on('error', (err) => {
			this.instance.log('error', `WebSocket error: ${err.message}`)
		})
	}

	/**
	 * Register all REST subscriptions against the current transportId.
	 */
	async subscribeAll() {
		const t = this.transportId
		const id = this.device.id

		const subs = [`/v1/devices/subscription/${t}`]

		if (id) {
			subs.push(
				`/v1/devices/${id}/name/subscription/${t}`,
				`/v1/devices/${id}/identify/subscription/${t}`,
				`/v1/devices/${id}/audio-mute/subscription/${t}`
			)

			for (const ch of this.channels.values()) {
				const chId = encodeURIComponent(ch.id)
				if (ch.capabilities.includes('mute')) {
					subs.push(`/v1/devices/${id}/audio-channels/${chId}/mute/subscription/${t}`)
				}
				if (ch.capabilities.includes('gain')) {
					subs.push(`/v1/devices/${id}/audio-channels/${chId}/gain/subscription/${t}`)
				}
				if (ch.capabilities.includes('name')) {
					subs.push(`/v1/devices/${id}/audio-channels/${chId}/name/subscription/${t}`)
				}
			}
		}

		const results = await Promise.allSettled(subs.map((path) => this.request('POST', path)))
		const failed = results.filter((r) => r.status === 'rejected')
		for (const f of failed) {
			this.instance.log('debug', `Subscription failed: ${f.reason?.message}`)
		}
	}

	/**
	 * Route an incoming WebSocket event into module state.
	 *
	 * @param {Object} msg - event with envelope/body
	 */
	processEvent(msg) {
		const { eventName, deviceId, audioChannelId } = msg.envelope
		const body = msg.body

		if (deviceId && this.device.id && deviceId !== this.device.id && eventName !== 'DEVICE_STATE_CHANGE') {
			return
		}

		switch (eventName) {
			case 'DEVICE_STATE_CHANGE':
				if (deviceId === this.device.id) {
					this.refreshDevice().catch((err) => {
						this.instance.log('debug', `Refresh after state change failed: ${err.message}`)
					})
				} else if (this.config.deviceMode !== 'id' && !this.device.id) {
					// maybe our device just appeared
					this.refreshDevice().catch(() => {})
				}
				break

			case 'DEVICE_NAME':
				this.device.name = body.name
				this.instance.setVariableValues({ device_name: body.name })
				break

			case 'DEVICE_IDENTIFY':
				this.device.identifying = body.identifying === true
				this.instance.checkFeedbacks('identifying')
				break

			case 'DEVICE_AUDIO_MUTE':
				this.device.audioMute = body.muted === true
				this.instance.setVariableValues({ audio_mute: this.device.audioMute ? 'Muted' : 'Unmuted' })
				this.instance.checkFeedbacks('device_muted')
				break

			case 'AUDIO_CHANNEL_MUTE': {
				const ch = this.channels.get(audioChannelId)
				if (ch) {
					ch.muted = body.muted === true
					this.instance.setVariableValues({ [`ch_${ch.index + 1}_mute`]: ch.muted ? 'Muted' : 'Unmuted' })
					this.instance.checkFeedbacks('channel_muted')
				}
				break
			}

			case 'AUDIO_CHANNEL_GAIN': {
				const ch = this.channels.get(audioChannelId)
				if (ch) {
					ch.gain = body.gain
					this.instance.setVariableValues({ [`ch_${ch.index + 1}_gain`]: ch.gain })
				}
				break
			}

			case 'AUDIO_CHANNEL_NAME': {
				const ch = this.channels.get(audioChannelId)
				if (ch) {
					ch.name = body.name
					this.instance.setVariableValues({ [`ch_${ch.index + 1}_name`]: ch.name })
					this.instance.rebuildChannelData()
				}
				break
			}
		}
	}
}
