/**
 * Define the actions for the module.
 *
 * @this {import('./index.js').default}
 */
export function updateActions() {
	const api = this.api

	const sendChannelPatch = async (channelId, capability, body) => {
		try {
			await api.request(
				'PATCH',
				`/v1/devices/${api.device.id}/audio-channels/${encodeURIComponent(channelId)}/${capability}`,
				body
			)
		} catch (err) {
			this.log('error', `Failed to set channel ${capability}: ${err.message}`)
		}
	}

	this.setActionDefinitions({
		channel_mute: {
			name: 'Channel Mute',
			options: [
				this.CHANNELS_FIELD(),
				{
					type: 'dropdown',
					label: 'Mute / Unmute / Toggle',
					id: 'choice',
					default: 'mute',
					choices: [
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async ({ options }) => {
				const ch = api.channels.get(options.channel)
				if (!ch) {
					return
				}
				const muted = options.choice === 'toggle' ? !ch.muted : options.choice === 'mute'
				await sendChannelPatch(ch.id, 'mute', { muted: muted })
			},
		},
		channel_gain_set: {
			name: 'Channel Gain (Set)',
			options: [
				this.CHANNELS_FIELD(),
				{
					type: 'textinput',
					label: 'Gain (dB)',
					id: 'gain',
					default: '0',
					useVariables: true,
					tooltip: 'The allowed range is reported by the device and clamped automatically.',
				},
			],
			callback: async ({ options }, context) => {
				const ch = api.channels.get(options.channel)
				const gain = parseFloat(await context.parseVariablesInString(options.gain))
				if (!ch || isNaN(gain)) {
					return
				}
				await sendChannelPatch(ch.id, 'gain', { gain: this.clampGain(ch, gain) })
			},
		},
		channel_gain_adjust: {
			name: 'Channel Gain (Increase/Decrease)',
			options: [
				this.CHANNELS_FIELD(),
				{
					type: 'number',
					label: 'Amount (dB)',
					id: 'amount',
					default: 1,
					min: -60,
					max: 60,
				},
			],
			callback: async ({ options }) => {
				const ch = api.channels.get(options.channel)
				if (!ch || typeof ch.gain !== 'number') {
					return
				}
				await sendChannelPatch(ch.id, 'gain', { gain: this.clampGain(ch, ch.gain + options.amount) })
			},
		},
		channel_name_set: {
			name: 'Channel Name (Set)',
			options: [
				this.CHANNELS_FIELD(),
				{
					type: 'textinput',
					label: 'Name',
					id: 'name',
					default: '',
					useVariables: true,
				},
			],
			callback: async ({ options }, context) => {
				const ch = api.channels.get(options.channel)
				const name = (await context.parseVariablesInString(options.name)).trim()
				if (!ch || name.length === 0) {
					return
				}
				await sendChannelPatch(ch.id, 'name', { name: name })
			},
		},
		device_mute: {
			name: 'Device Audio Mute',
			options: [
				{
					type: 'dropdown',
					label: 'Mute / Unmute / Toggle',
					id: 'choice',
					default: 'mute',
					choices: [
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async ({ options }) => {
				const muted = options.choice === 'toggle' ? !api.device.audioMute : options.choice === 'mute'
				try {
					await api.request('PATCH', `/v1/devices/${api.device.id}/audio-mute`, { muted: muted })
				} catch (err) {
					this.log('error', `Failed to set device mute: ${err.message}`)
				}
			},
		},
		identify: {
			name: 'Identify Device (Flash)',
			options: [
				{
					type: 'dropdown',
					label: 'Start / Stop / Toggle',
					id: 'choice',
					default: 'start',
					choices: [
						{ id: 'start', label: 'Start' },
						{ id: 'stop', label: 'Stop' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async ({ options }) => {
				const start = options.choice === 'toggle' ? !api.device.identifying : options.choice === 'start'
				try {
					await api.request('POST', `/v1/devices/${api.device.id}/identify/${start ? 'start' : 'stop'}`)
				} catch (err) {
					this.log('error', `Failed to identify: ${err.message}`)
				}
			},
		},
		device_name_set: {
			name: 'Device Name (Set)',
			options: [
				{
					type: 'textinput',
					label: 'Name',
					id: 'name',
					default: '',
					useVariables: true,
				},
			],
			callback: async ({ options }, context) => {
				const name = (await context.parseVariablesInString(options.name)).trim()
				if (name.length === 0) {
					return
				}
				try {
					await api.request('PATCH', `/v1/devices/${api.device.id}/name`, { name: name })
				} catch (err) {
					this.log('error', `Failed to set device name: ${err.message}`)
				}
			},
		},
		reboot: {
			name: 'Reboot Device',
			options: [],
			callback: async () => {
				try {
					await api.request('POST', `/v1/devices/${api.device.id}/reboot`)
				} catch (err) {
					this.log('error', `Failed to reboot: ${err.message}`)
				}
			},
		},
	})
}
