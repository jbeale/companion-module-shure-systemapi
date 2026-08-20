import { combineRgb } from '@companion-module/base'

/**
 * Define the feedbacks for the module.
 *
 * @this {import('./main.js').default}
 */
export function updateFeedbacks() {
	const api = this.api

	this.setFeedbackDefinitions({
		channel_muted: {
			type: 'boolean',
			name: 'Channel Is Muted',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(128, 0, 0),
			},
			options: [this.CHANNELS_FIELD()],
			callback: ({ options }) => {
				return api.channels.get(options.channel)?.muted === true
			},
		},
		device_muted: {
			type: 'boolean',
			name: 'Device Audio Is Muted',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(128, 0, 0),
			},
			options: [],
			callback: () => {
				return api.device.audioMute === true
			},
		},
		identifying: {
			type: 'boolean',
			name: 'Device Is Identifying (Flashing)',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			options: [],
			callback: () => {
				return api.device.identifying === true
			},
		},
		device_online: {
			type: 'boolean',
			name: 'Device Is Online',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 128, 0),
			},
			options: [],
			callback: () => {
				return api.device.state === 'ONLINE'
			},
		},
	})
}
