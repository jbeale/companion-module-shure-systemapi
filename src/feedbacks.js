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
		pack_battery_low: {
			type: 'boolean',
			name: 'Pack Battery Below Threshold',
			description: 'Turns on when the selected pack drops to or below the battery percentage given.',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 191, 0),
			},
			options: [
				this.PACKS_FIELD(),
				{
					type: 'number',
					label: 'Battery at or below (%)',
					id: 'threshold',
					default: 25,
					min: 0,
					max: 100,
				},
				{
					type: 'checkbox',
					label: 'Also trigger when the pack is offline',
					id: 'offlineToo',
					default: true,
				},
			],
			callback: ({ options }) => {
				const pack = api.getPacks()[Number(options.pack) - 1]
				if (!pack) {
					return false
				}
				if (pack.state !== 'ONLINE') {
					return options.offlineToo === true
				}
				return typeof pack.percentage === 'number' && pack.percentage <= options.threshold
			},
		},
		any_pack_battery_low: {
			type: 'boolean',
			name: 'Any Pack Battery Below Threshold',
			description: 'Turns on when any tracked pack drops to or below the battery percentage given.',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(192, 38, 38),
			},
			options: [
				{
					type: 'number',
					label: 'Battery at or below (%)',
					id: 'threshold',
					default: 25,
					min: 0,
					max: 100,
				},
			],
			callback: ({ options }) => {
				return api
					.getPacks()
					.some((p) => p.state === 'ONLINE' && typeof p.percentage === 'number' && p.percentage <= options.threshold)
			},
		},
		pack_charging: {
			type: 'boolean',
			name: 'Pack Is Charging',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(63, 187, 117),
			},
			options: [this.PACKS_FIELD()],
			callback: ({ options }) => {
				return api.getPacks()[Number(options.pack) - 1]?.batteryState === 'CHARGING'
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
