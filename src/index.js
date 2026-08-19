import { InstanceBase, InstanceStatus, Regex, runEntrypoint } from '@companion-module/base'
import { updateActions } from './actions.js'
import { updateFeedbacks } from './feedbacks.js'
import { updateVariables } from './variables.js'
import SystemApiClient from './api.js'
import { UpgradeScripts } from './upgrades.js'

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
class ShureADPSMInstance extends InstanceBase {
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
			deviceMode: this.config.deviceMode ?? 'auto',
			deviceId: (this.config.deviceId ?? '').trim(),
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
					'Discovered ADTQ/ADTD devices and their IDs are listed in the connection log.',
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
				id: 'deviceMode',
				label: 'Device Selection',
				width: 6,
				default: 'auto',
				choices: [
					{ id: 'auto', label: 'First discovered ADTQ/ADTD' },
					{ id: 'id', label: 'Specific device by ID' },
				],
			},
			{
				type: 'textinput',
				id: 'deviceId',
				label: 'Device ID',
				tooltip: 'The hardware device ID (UUID) as reported by the SystemAPI Server. See the connection log.',
				width: 6,
				isVisible: (config) => config.deviceMode === 'id',
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
	 * Re-publish actions, feedbacks and variables after the channel
	 * list or channel names change, so dropdown labels stay current.
	 */
	rebuildChannelData() {
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()
		this.checkFeedbacks()
	}
}

runEntrypoint(ShureADPSMInstance, UpgradeScripts)
