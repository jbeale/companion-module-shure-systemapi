/**
 * Simulation state for the mock Shure SystemAPI Server.
 *
 * Models ADTQ/ADTD transmitters and ADXR bodypack receivers ("packs").
 * Shapes here mirror the real SystemAPI v1.8 OpenAPI schemas so the module
 * exercises the same parsing paths it will use against real hardware.
 */

import { EventEmitter } from 'node:events'

/** Capability names advertised per model. */
// Verified against a real ADTQ (firmware 1.2.1.1) on SystemAPI Server 6.10:
// no audio-mute, no user-presets, no battery, no RF of any kind.
const REAL_TX_CAPABILITIES = [
	'audio-channels',
	'audio-channels-v2',
	'audio-network',
	'authentication',
	'available-firmware',
	'control-network',
	'dante-audio-network',
	'factory-reset',
	'firmware-update-requests',
	'hosted-firmware',
	'identify',
	'name',
	'reboot',
	'uptime',
]

const CAPABILITIES = {
	ADTQ: [...REAL_TX_CAPABILITIES],
	ADTD: [...REAL_TX_CAPABILITIES],
	// ANX4 verified on the same rig: same device capabilities as an ADTQ, but its
	// channels DO expose mute, which ADPSM channels do not.
	ANX4: [...REAL_TX_CAPABILITIES],
	// ULXD6 (bodypack) and ULXD8 (handheld) are battery-powered transmitters on
	// Shure's SystemAPI supported list. Capability names are inferred from the
	// endpoint paths and have not been confirmed on hardware.
	ULXD6: ['battery-level', 'battery-health', 'control-network', 'name', 'identify', 'uptime'],
	ULXD8: ['battery-level', 'battery-health', 'control-network', 'name', 'identify', 'uptime'],
	// Speculative: an ADPSM bodypack has not yet been observed on a real server
	// (the one rig scanned had every pack powered off), so this capability set is
	// a best guess. Kept so the module's battery path stays exercisable.
	ADXR: ['battery-level', 'battery-health', 'control-network', 'name', 'identify'],
}

const CHANNEL_COUNT = { ADTQ: 4, ADTD: 2, ANX4: 12, ULXD6: 0, ULXD8: 0, ADXR: 0 }

/** Channel capability sets differ by family; ANX4 has mute, ADPSM does not. */
const CHANNEL_CAPABILITIES = {
	ANX4: ['activity', 'gain', 'mute', 'name'],
	DEFAULT: ['activity', 'gain', 'name'],
}

/** Models that report a battery. */
const BATTERY_MODELS = new Set(['ULXD6', 'ULXD8', 'ADXR'])

/** Battery states from the DeviceBatteryState enum. */
export const BATTERY_STATES = ['CHARGING', 'DISCHARGING', 'FULL', 'EMPTY', 'CALCULATING', 'OPTIMAL_STORAGE']
/** Audio activity levels from the AudioChannelActivityResponse enum. */
export const ACTIVITY_LEVELS = ['LOW', 'GOOD', 'CLIPPING']

let idCounter = 0
let ipCounter = 40

/**
 * Build a Shure-style device UUID.
 * @returns {string} device id
 */
function makeDeviceId() {
	const n = (++idCounter).toString(16).padStart(6, '0').toUpperCase()
	return `DD${n}-0000-11DD-A000-000EDDCCCCCC`
}

/**
 * Encode an audio channel id the same way the real server does: base64 of a
 * JSON descriptor that carries the channel index.
 *
 * @param {string} deviceId - owning device
 * @param {number} index - zero-based channel index
 * @returns {string} base64 audio channel id
 */
function makeChannelId(deviceId, index) {
	// matches the real ADTQ descriptor: {"t","c","v","s","i"} with the index in `i`
	const payload = {
		t: 'AudioChannel',
		c: 'ADTQ',
		v: 131088,
		s: 'CH',
		i: index,
	}
	return Buffer.from(JSON.stringify(payload)).toString('base64')
}

/**
 * ISO-8601 duration for a whole number of minutes, e.g. PT853M.
 * @param {number} minutes
 * @returns {string} duration
 */
function isoMinutes(minutes) {
	return `PT${Math.max(0, Math.round(minutes))}M`
}

export class SimState extends EventEmitter {
	constructor() {
		super()
		/** @type {Map<string, object>} deviceId -> device */
		this.devices = new Map()
		this.tickTimer = null
	}

	/**
	 * Create a device and announce it.
	 *
	 * @param {string} model - ADTQ, ADTD or ADXR
	 * @param {Object} [opts] - name, parentId, parentChannel
	 * @returns {Object} the created device
	 */
	addDevice(model, opts = {}) {
		if (!CAPABILITIES[model]) {
			throw new Error(`Unknown model ${model}`)
		}

		const deviceId = makeDeviceId()
		const channelCount = CHANNEL_COUNT[model]

		const device = {
			deviceId: deviceId,
			serialNumber: `2TJ${String(100000 + idCounter)}`,
			model: model,
			firmwareVersion: model === 'ADXR' ? '1.0.5' : '1.0.5',
			deviceState: 'ONLINE',
			compatibility: 'COMPATIBLE_LATEST',
			address: `192.168.1.${ipCounter++}`,
			name: opts.name || `${model}-${String(idCounter).padStart(2, '0')}`,
			identifying: false,
			audioMute: false,
			capabilities: [...CAPABILITIES[model]],
			channels: [],
			battery: null,
			parentId: opts.parentId || null,
			parentChannel: opts.parentChannel ?? null,
		}

		for (let i = 0; i < channelCount; i++) {
			device.channels.push({
				id: makeChannelId(deviceId, i),
				index: i,
				name: `Ch ${i + 1}`,
				muted: false,
				gain: 6,
				gainRange: { min: -20, max: 16, step: 1 },
				activity: 'LOW',
				role: 'SOURCE',
				group: 'GENERIC',
				// ADPSM channels expose no mute; ANX4 channels do
				capabilities: [...(CHANNEL_CAPABILITIES[model] ?? CHANNEL_CAPABILITIES.DEFAULT)],
			})
		}

		if (BATTERY_MODELS.has(model)) {
			device.battery = {
				percentage: 87,
				state: 'DISCHARGING',
				minutesToTarget: 385,
				healthPercentage: 96,
				cycleCount: 42,
				drain: false,
			}
		}

		this.devices.set(deviceId, device)
		this.emit('device-state-change', device)
		this.emit('changed')
		return device
	}

	/**
	 * Remove a device, and any packs parented to it.
	 * @param {string} deviceId
	 */
	removeDevice(deviceId) {
		const device = this.devices.get(deviceId)
		if (!device) return

		for (const child of [...this.devices.values()]) {
			if (child.parentId === deviceId) {
				this.devices.delete(child.deviceId)
			}
		}
		this.devices.delete(deviceId)
		this.emit('changed')
	}

	/**
	 * @param {string} deviceId
	 * @returns {Object|undefined} device
	 */
	get(deviceId) {
		return this.devices.get(deviceId)
	}

	/** @returns {Array<Object>} all devices */
	list() {
		return [...this.devices.values()]
	}

	/**
	 * Find a channel on a device.
	 * @param {string} deviceId
	 * @param {string} channelId
	 * @returns {Object|undefined} channel
	 */
	channel(deviceId, channelId) {
		return this.devices.get(deviceId)?.channels.find((c) => c.id === channelId)
	}

	/**
	 * Apply a change to a device and emit the matching API event.
	 *
	 * @param {string} deviceId - target device
	 * @param {string} field - what to change
	 * @param {any} value - new value
	 */
	setDeviceField(deviceId, field, value) {
		const device = this.devices.get(deviceId)
		if (!device) return

		switch (field) {
			case 'name':
				device.name = String(value)
				this.emit('event', 'DEVICE_NAME', device, { name: device.name })
				break
			case 'identifying':
				device.identifying = !!value
				this.emit('event', 'DEVICE_IDENTIFY', device, { identifying: device.identifying })
				break
			case 'audioMute':
				device.audioMute = !!value
				this.emit('event', 'DEVICE_AUDIO_MUTE', device, { muted: device.audioMute })
				break
			case 'deviceState':
				device.deviceState = value
				this.emit('device-state-change', device)
				break
			default:
				return
		}
		this.emit('changed')
	}

	/**
	 * Change a battery property on a pack and emit the battery event.
	 *
	 * @param {string} deviceId - the pack
	 * @param {string} field - percentage, state, minutesToTarget, healthPercentage, cycleCount, drain
	 * @param {any} value - new value
	 */
	setBatteryField(deviceId, field, value) {
		const device = this.devices.get(deviceId)
		if (!device?.battery) return

		if (field === 'percentage') {
			device.battery.percentage = Math.min(100, Math.max(0, Number(value)))
		} else if (field === 'state') {
			if (!BATTERY_STATES.includes(value)) return
			device.battery.state = value
		} else if (field === 'drain') {
			device.battery.drain = !!value
		} else if (field === 'healthPercentage') {
			device.battery.healthPercentage = Math.min(100, Math.max(0, Number(value)))
		} else if (field === 'cycleCount') {
			device.battery.cycleCount = Math.max(0, Math.round(Number(value)))
		} else if (field === 'minutesToTarget') {
			device.battery.minutesToTarget = Math.max(0, Number(value))
		} else {
			return
		}

		if (field === 'healthPercentage' || field === 'cycleCount') {
			this.emit('event', 'DEVICE_BATTERY_HEALTH', device, this.batteryHealthBody(device))
		} else {
			this.emit('event', 'DEVICE_BATTERY_LEVEL', device, this.batteryLevelBody(device))
		}
		this.emit('changed')
	}

	/**
	 * Change a channel property and emit the matching audio channel event.
	 *
	 * @param {string} deviceId - owning device
	 * @param {string} channelId - target channel
	 * @param {string} field - muted, gain, name, activity
	 * @param {any} value - new value
	 */
	setChannelField(deviceId, channelId, field, value) {
		const device = this.devices.get(deviceId)
		const channel = this.channel(deviceId, channelId)
		if (!device || !channel) return

		switch (field) {
			case 'muted':
				channel.muted = !!value
				this.emit('channel-event', 'AUDIO_CHANNEL_MUTE', device, channel, { muted: channel.muted })
				break
			case 'gain': {
				const g = Number(value)
				channel.gain = Math.min(channel.gainRange.max, Math.max(channel.gainRange.min, g))
				this.emit('channel-event', 'AUDIO_CHANNEL_GAIN', device, channel, { gain: channel.gain })
				break
			}
			case 'name':
				channel.name = String(value)
				this.emit('channel-event', 'AUDIO_CHANNEL_NAME', device, channel, { name: channel.name })
				break
			case 'activity':
				if (!ACTIVITY_LEVELS.includes(value)) return
				channel.activity = value
				this.emit('channel-event', 'AUDIO_CHANNEL_ACTIVITY', device, channel, { audioLevel: channel.activity })
				break
			default:
				return
		}
		this.emit('changed')
	}

	/**
	 * DeviceBatteryLevelResponse body for a pack.
	 * @param {Object} device
	 * @returns {Object} response body
	 */
	batteryLevelBody(device) {
		const b = device.battery
		const settled = b.state === 'FULL' || b.state === 'EMPTY' || b.state === 'OPTIMAL_STORAGE'
		const calculating = b.state === 'CALCULATING'

		let targetState = null
		if (b.state === 'CHARGING') targetState = 'FULL'
		else if (b.state === 'DISCHARGING') targetState = 'EMPTY'

		return {
			percentage: Math.round(b.percentage),
			status: {
				currentState: b.state,
				targetState: targetState,
				timeToTargetState: settled || calculating ? null : isoMinutes(b.minutesToTarget),
			},
		}
	}

	/**
	 * DeviceBatteryHealthResponse body for a pack.
	 * @param {Object} device
	 * @returns {Object} response body
	 */
	batteryHealthBody(device) {
		return {
			percentage: Math.round(device.battery.healthPercentage),
			cycleCount: device.battery.cycleCount,
		}
	}

	/**
	 * Start the simulation tick: drains batteries that have drain enabled and
	 * re-emits audio activity on the same 5s cadence as the real server.
	 */
	start() {
		let ticks = 0
		this.tickTimer = setInterval(() => {
			ticks++

			for (const device of this.devices.values()) {
				if (device.deviceState !== 'ONLINE') continue

				if (device.battery?.drain) {
					const b = device.battery
					const delta = b.state === 'CHARGING' ? 0.5 : -0.5
					const next = Math.min(100, Math.max(0, b.percentage + delta))

					if (next !== b.percentage) {
						b.percentage = next
						// crude but plausible runtime estimate: ~4.5 min per percent
						b.minutesToTarget = b.state === 'CHARGING' ? (100 - next) * 1.5 : next * 4.5

						if (next <= 0) b.state = 'EMPTY'
						else if (next >= 100) b.state = 'FULL'

						this.emit('event', 'DEVICE_BATTERY_LEVEL', device, this.batteryLevelBody(device))
						this.emit('changed')
					}
				}

				// the real server pushes activity every 5 seconds
				if (ticks % 5 === 0) {
					for (const channel of device.channels) {
						this.emit('channel-event', 'AUDIO_CHANNEL_ACTIVITY', device, channel, {
							audioLevel: channel.activity,
						})
					}
				}
			}
		}, 1000)
	}

	/** Stop the simulation tick. */
	stop() {
		if (this.tickTimer) clearInterval(this.tickTimer)
		this.tickTimer = null
	}
}
