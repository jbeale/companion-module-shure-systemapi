import { InstanceBase, InstanceStatus, Regex } from '@companion-module/base'
import { updateActions } from './actions.js'
import { updateFeedbacks } from './feedbacks.js'
import { updateVariables } from './variables.js'
import SystemApiClient from './api.js'

export { UpgradeScripts } from './upgrades.js'

/**
 * Companion instance class for Shure Axient Digital PSM transmitters
 * (ADTQ/ADTD), controlled via the Shure SystemAPI Server.
 *
 * Unlike Shure's older wireless products there is no direct TCP command
 * string interface on these devices; Shure only exposes them through the
 * SystemAPI Server middleware (REST + WebSocket).
 *
 * @extends InstanceBase
 */
export default class ShureADPSMInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.updateActions = updateActions.bind(this)
		this.updateFeedbacks = updateFeedbacks.bind(this)
		this.updateVariables = updateVariables.bind(this)
	}

	/**
	 * Main initialization when the module is started.
	 *
	 * @param {Object} config - the configuration
	 */
	async init(config) {
		this.config = config
		// devices seen on the server, used to populate the device picker
		this.discovered = []

		this.api = new SystemApiClient(this)

		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()

		this.startConnection()
	}

	/**
	 * Process an updated configuration.
	 *
	 * @param {Object} config - the new configuration
	 */
	async configUpdated(config) {
		this.config = config
		this.startConnection()
	}

	/**
	 * (Re)start the SystemAPI client with the current config.
	 */
	startConnection() {
		this.api.destroy()

		if (!this.config.host || !this.config.apiKey) {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing SystemAPI Server address or API key')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)

		this.api.init({
			host: this.config.host,
			port: this.config.port ?? 10000,
			apiKey: this.config.apiKey,
			device: String(this.config.device ?? 'auto').trim(),
		})
	}

	/**
	 * Clean up the instance before it is destroyed.
	 */
	async destroy() {
		if (this.api) {
			this.api.destroy()
		}

		this.log('debug', 'destroy', this.id)
	}

	/**
	 * Creates the configuration fields for web config.
	 *
	 * @returns {Array} the config fields
	 */
	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				label: 'Information',
				width: 12,
				value:
					'ADTQ/ADTD transmitters are controlled through the <b>Shure SystemAPI Server</b> (6.5.0 or later), not directly. ' +
					'Install it from shure.com, then enter its address and shared secret API key below. ' +
					'Save, then reopen this page to pick your transmitter by name from the Device list.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'SystemAPI Server IP/Host',
				width: 6,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'SystemAPI Server Port',
				default: '10000',
				width: 2,
				regex: Regex.PORT,
			},
			{
				type: 'textinput',
				id: 'apiKey',
				label: 'API Key (Shared Secret)',
				width: 12,
			},
			{
				type: 'dropdown',
				id: 'device',
				label: 'Device',
				width: 12,
				default: 'auto',
				choices: this.deviceChoices(),
				allowCustom: true,
				regex: '/^(auto|[0-9a-fA-F-]{36})$/',
				minChoicesForSearch: 6,
				tooltip:
					'Pick the transmitter this connection controls.\n\n' +
					'The list is populated from the SystemAPI Server once this connection has ' +
					'reached it, so on a brand new connection: fill in the address and API key, ' +
					'save, then reopen this page and the devices will be listed by name. ' +
					'A device ID can also be typed in directly.',
			},
		]
	}

	/**
	 * Clamp a gain value into the device-reported range for a channel.
	 *
	 * @param {Object} channel - channel state object
	 * @param {number} gain - requested gain
	 * @returns {number} the clamped gain
	 */
	clampGain(channel, gain) {
		if (channel.gainRange) {
			return Math.min(Math.max(gain, channel.gainRange.min), channel.gainRange.max)
		}
		return gain
	}

	/**
	 * Channel dropdown option built from the current channel list.
	 * A function so each action/feedback gets its own object instance.
	 *
	 * @returns {Object} dropdown field definition
	 */
	CHANNELS_FIELD() {
		const choices = this.api.getChannels().map((ch) => ({
			id: ch.id,
			label: `Channel ${ch.index + 1}${ch.name ? ` (${ch.name})` : ''}`,
		}))

		return {
			type: 'dropdown',
			label: 'Channel',
			id: 'channel',
			default: choices[0]?.id ?? '',
			choices: choices,
		}
	}

	/**
	 * Choices for the device picker, built from whatever the server last reported.
	 *
	 * @returns {Array<Object>} dropdown choices
	 */
	deviceChoices() {
		const choices = [{ id: 'auto', label: 'Auto — first ADTQ/ADTD found' }]

		for (const d of this.discovered ?? []) {
			const bits = [d.model]
			if (d.name && d.name !== d.model) {
				bits.push(`"${d.name}"`)
			}
			if (d.address) {
				bits.push(d.address)
			}
			if (d.state && d.state !== 'ONLINE') {
				bits.push(`[${d.state}]`)
			}
			choices.push({ id: d.id, label: bits.join('  ') })
		}

		return choices
	}

	/**
	 * Pack dropdown option built from the current battery-device list.
	 * Packs are addressed by position so button config survives a pack
	 * being swapped for another unit mid-show.
	 *
	 * @returns {Object} dropdown field definition
	 */
	PACKS_FIELD() {
		const packs = this.api.getPacks()
		const choices = packs.map((pack, i) => ({
			id: String(i + 1),
			label: `Pack ${i + 1}${pack.name ? ` (${pack.name})` : ''}`,
		}))

		if (choices.length === 0) {
			choices.push({ id: '1', label: 'Pack 1' })
		}

		return {
			type: 'dropdown',
			label: 'Pack',
			id: 'pack',
			default: '1',
			choices: choices,
		}
	}

	/**
	 * Re-publish actions, feedbacks and variables after the channel
	 * list or channel names change, so dropdown labels stay current.
	 */
	rebuildChannelData() {
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()
		this.checkAllFeedbacks()
	}
}
