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
	 * @param {import('./main.js').default} instance - the module instance
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
		// deviceId -> battery-capable device (ADXR bodypack etc.), sorted by name for display
		this.packs = new Map()
	}

	/**
	 * Battery-capable devices, ordered by name so pack numbering is stable.
	 * @returns {Array<Object>} packs
	 */
	getPacks() {
		return [...this.packs.values()].sort((a, b) => a.name.localeCompare(b.name))
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
						// Only declare a JSON body when there is one: the server rejects
						// `Content-Type: application/json` with an empty body ("Body cannot
						// be empty when content-type is set to 'application/json'"), which
						// would otherwise fail every bodyless POST — including all
						// subscription registrations.
						...(payload !== undefined
							? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
							: {}),
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
				},
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
	 * Normalise the device list response.
	 *
	 * The spec's ListDevicesResponse is Relay-style pagination
	 * (`{pageInfo, edges:[{cursor, node}]}`), while the Getting Started guide
	 * shows a bare array. Accept both, plus an `items` wrapper, so a server
	 * change cannot silently empty the device list.
	 *
	 * @param {any} response - parsed GET /v1/devices body
	 * @returns {Array<Object>} device nodes
	 */
	normaliseDeviceList(response) {
		if (Array.isArray(response)) {
			return response
		}
		if (Array.isArray(response?.edges)) {
			return response.edges.map((e) => e?.node).filter(Boolean)
		}
		if (Array.isArray(response?.items)) {
			return response.items
		}
		return []
	}

	/**
	 * Discover devices, pick the configured ADPSM transmitter, and load its state.
	 */
	async refreshDevice() {
		const devices = await this.request('GET', '/v1/devices')
		const list = this.normaliseDeviceList(devices)

		await this.refreshPacks(list)

		const adpsm = list.filter((d) => ['ADTQ', 'ADTD'].includes(d.softwareIdentity?.model))

		for (const d of adpsm) {
			this.instance.log(
				'debug',
				`Found ${d.softwareIdentity.model} (${d.deviceState}) at ${d.communicationProtocol?.address} — deviceId ${d.hardwareIdentity?.deviceId}`,
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
	 * Track every battery-capable device on the server (ADXR bodypacks and
	 * anything else reporting a battery) and load its battery state.
	 *
	 * The API exposes no parent/child link between a transmitter and its packs,
	 * so all battery devices on the server are surfaced, ordered by name.
	 *
	 * @param {Array<Object>} list - normalised device list
	 */
	async refreshPacks(list) {
		const battery = list.filter(
			(d) => d.capabilities?.includes('battery-level') || d.capabilities?.includes('battery-health'),
		)

		const known = new Set()
		let structureChanged = false

		for (const node of battery) {
			const id = node.hardwareIdentity?.deviceId
			if (!id) continue
			known.add(id)

			let pack = this.packs.get(id)
			if (!pack) {
				pack = {
					id: id,
					name: '',
					model: node.softwareIdentity?.model ?? '',
					state: node.deviceState,
					percentage: null,
					batteryState: '',
					targetState: '',
					runtimeMinutes: null,
					health: null,
					cycles: null,
					subscribed: false,
				}
				this.packs.set(id, pack)
				structureChanged = true
			}
			pack.state = node.deviceState

			if (node.deviceState !== 'ONLINE') continue

			const [name, level, health] = (
				await Promise.allSettled([
					this.request('GET', `/v1/devices/${id}/name`),
					this.request('GET', `/v1/devices/${id}/battery-level`),
					this.request('GET', `/v1/devices/${id}/battery-health`),
				])
			).map((r) => (r.status === 'fulfilled' ? r.value : null))

			if (name?.name !== undefined && name.name !== pack.name) {
				pack.name = name.name
				structureChanged = true
			}
			if (level) {
				this.applyBatteryLevel(pack, level)
			}
			if (health) {
				pack.health = health.percentage
				pack.cycles = health.cycleCount
			}
		}

		for (const id of [...this.packs.keys()]) {
			if (!known.has(id)) {
				this.packs.delete(id)
				structureChanged = true
			}
		}

		if (structureChanged) {
			this.instance.rebuildChannelData()
		}
		this.publishPackVariables()
	}

	/**
	 * Copy a DeviceBatteryLevelResponse onto a pack.
	 *
	 * @param {Object} pack - pack state
	 * @param {Object} body - battery level response
	 */
	applyBatteryLevel(pack, body) {
		pack.percentage = body.percentage
		pack.batteryState = body.status?.currentState ?? ''
		pack.targetState = body.status?.targetState ?? ''
		pack.runtimeMinutes = this.parseIsoMinutes(body.status?.timeToTargetState)
	}

	/**
	 * Parse an ISO-8601 duration like `PT853M` into whole minutes.
	 *
	 * @param {string|null} value - duration
	 * @returns {number|null} minutes, or null when unknown
	 */
	parseIsoMinutes(value) {
		if (typeof value !== 'string') {
			return null
		}
		const m = value.match(/^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/)
		if (!m) {
			return null
		}
		const [, d, h, min, s] = m
		const total = (Number(d) || 0) * 1440 + (Number(h) || 0) * 60 + (Number(min) || 0) + (Number(s) || 0) / 60
		return Math.round(total)
	}

	/**
	 * Push all pack variables and refresh battery feedbacks.
	 */
	publishPackVariables() {
		const values = { pack_count: this.packs.size }
		let lowest = null

		this.getPacks().forEach((pack, i) => {
			const n = i + 1
			values[`pack_${n}_name`] = pack.name
			values[`pack_${n}_model`] = pack.model
			values[`pack_${n}_battery`] = pack.percentage ?? ''
			values[`pack_${n}_battery_state`] = pack.batteryState
			values[`pack_${n}_runtime`] = this.formatRuntime(pack.runtimeMinutes)
			values[`pack_${n}_runtime_minutes`] = pack.runtimeMinutes ?? ''
			values[`pack_${n}_health`] = pack.health ?? ''
			values[`pack_${n}_cycles`] = pack.cycles ?? ''
			values[`pack_${n}_state`] = pack.state

			if (typeof pack.percentage === 'number' && pack.state === 'ONLINE') {
				if (lowest === null || pack.percentage < lowest) {
					lowest = pack.percentage
				}
			}
		})

		values.pack_lowest_battery = lowest ?? ''
		this.instance.setVariableValues(values)
		this.instance.checkFeedbacks('pack_battery_low', 'any_pack_battery_low')
	}

	/**
	 * Format remaining runtime as `H:MM`, matching how mixers usually show it.
	 *
	 * @param {number|null} minutes - remaining minutes
	 * @returns {string} formatted runtime
	 */
	formatRuntime(minutes) {
		if (typeof minutes !== 'number') {
			return ''
		}
		const h = Math.floor(minutes / 60)
		const m = minutes % 60
		return `${h}:${String(m).padStart(2, '0')}`
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
			const list = Array.isArray(audioChannels) ? audioChannels : (audioChannels?.items ?? [])
			await this.loadChannels(list)
		}

		const deviceValues = { device_name: this.device.name }
		if (has('audio-mute')) {
			deviceValues.audio_mute = this.device.audioMute ? 'Muted' : 'Unmuted'
		}
		this.instance.setVariableValues(deviceValues)
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
			if (!ch.capabilities.some((c) => ['mute', 'gain', 'name', 'activity'].includes(c))) {
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
					activity: '',
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
					: null,
			)
			reqs.push(
				channel.capabilities.includes('mute')
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/mute`)
					: null,
			)
			reqs.push(
				channel.capabilities.includes('gain')
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/gain`)
					: null,
			)
			reqs.push(
				channel.capabilities.includes('gain') && channel.gainRange === null
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/gain/description`)
					: null,
			)
			reqs.push(
				channel.capabilities.includes('activity')
					? this.request('GET', `/v1/devices/${id}/audio-channels/${encodeURIComponent(ch.id)}/activity`)
					: null,
			)

			const [name, mute, gain, gainDesc, activity] = (await Promise.allSettled(reqs)).map((r) =>
				r.status === 'fulfilled' ? r.value : null,
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
			if (activity) {
				channel.activity = activity.audioLevel ?? ''
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
			// Axient Digital PSM uses a compact descriptor where the index is `i`
			// (e.g. {"t":"AudioChannel","c":"ADTQ","v":131088,"s":"CH","i":0}), while
			// other Shure devices use the longer form with `index`.
			if (typeof decoded.i === 'number') {
				return decoded.i
			}
			if (typeof decoded.index === 'number') {
				return decoded.index
			}
			return -1
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
				`/v1/devices/${id}/audio-mute/subscription/${t}`,
			)
		}

		for (const pack of this.packs.values()) {
			subs.push(
				`/v1/devices/${pack.id}/battery-level/subscription/${t}`,
				`/v1/devices/${pack.id}/battery-health/subscription/${t}`,
				`/v1/devices/${pack.id}/name/subscription/${t}`,
			)
		}

		if (id) {
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
				if (ch.capabilities.includes('activity')) {
					subs.push(`/v1/devices/${id}/audio-channels/${chId}/activity/subscription/${t}`)
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

		// battery-bearing packs are tracked alongside the selected transmitter
		const pack = deviceId ? this.packs.get(deviceId) : undefined
		if (pack) {
			switch (eventName) {
				case 'DEVICE_BATTERY_LEVEL':
					this.applyBatteryLevel(pack, body)
					this.publishPackVariables()
					return
				case 'DEVICE_BATTERY_HEALTH':
					pack.health = body.percentage
					pack.cycles = body.cycleCount
					this.publishPackVariables()
					return
				case 'DEVICE_NAME':
					pack.name = body.name
					this.instance.rebuildChannelData()
					return
			}
		}

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

			case 'AUDIO_CHANNEL_ACTIVITY': {
				const ch = this.channels.get(audioChannelId)
				if (ch && ch.activity !== body.audioLevel) {
					ch.activity = body.audioLevel
					this.instance.setVariableValues({ [`ch_${ch.index + 1}_activity`]: ch.activity })
					this.instance.checkFeedbacks('channel_activity')
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
