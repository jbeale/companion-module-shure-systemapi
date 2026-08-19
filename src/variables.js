/**
 * Define the variables for the module.
 *
 * @this {import('./index.js').default}
 */
export function updateVariables() {
	const variables = [
		{ variableId: 'device_name', name: 'Device Name' },
		{ variableId: 'device_id', name: 'Device ID' },
		{ variableId: 'model', name: 'Model (ADTQ/ADTD)' },
		{ variableId: 'firmware', name: 'Firmware Version' },
		{ variableId: 'device_state', name: 'Device State' },
		{ variableId: 'ip_address', name: 'IP Address' },
		{ variableId: 'audio_mute', name: 'Device Audio Mute' },
	]

	for (const ch of this.api.getChannels()) {
		const n = ch.index + 1
		variables.push(
			{ variableId: `ch_${n}_name`, name: `Channel ${n} Name` },
			{ variableId: `ch_${n}_mute`, name: `Channel ${n} Mute` },
			{ variableId: `ch_${n}_gain`, name: `Channel ${n} Gain (dB)` }
		)
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
