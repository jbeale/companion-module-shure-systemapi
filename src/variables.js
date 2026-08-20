/**
 * Define the variables for the module.
 *
 * @this {import('./main.js').default}
 */
export function updateVariables() {
	const variables = {
		device_name: { name: 'Device Name' },
		device_id: { name: 'Device ID' },
		model: { name: 'Model (ADTQ/ADTD)' },
		firmware: { name: 'Firmware Version' },
		device_state: { name: 'Device State' },
		ip_address: { name: 'IP Address' },
		audio_mute: { name: 'Device Audio Mute' },
	}

	for (const ch of this.api.getChannels()) {
		const n = ch.index + 1
		variables[`ch_${n}_name`] = { name: `Channel ${n} Name` }
		variables[`ch_${n}_mute`] = { name: `Channel ${n} Mute` }
		variables[`ch_${n}_gain`] = { name: `Channel ${n} Gain (dB)` }
	}

	this.setVariableDefinitions(variables)

	const values = {}
	for (const ch of this.api.getChannels()) {
		const n = ch.index + 1
		values[`ch_${n}_name`] = ch.name
		values[`ch_${n}_mute`] = ch.muted ? 'Muted' : 'Unmuted'
		values[`ch_${n}_gain`] = ch.gain ?? ''
	}
	this.setVariableValues(values)
}
