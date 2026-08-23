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

	variables.pack_count = { name: 'Pack Count' }
	variables.pack_lowest_battery = { name: 'Lowest Pack Battery (%)' }

	this.api.getPacks().forEach((_pack, i) => {
		const n = i + 1
		variables[`pack_${n}_name`] = { name: `Pack ${n} Name` }
		variables[`pack_${n}_model`] = { name: `Pack ${n} Model` }
		variables[`pack_${n}_battery`] = { name: `Pack ${n} Battery (%)` }
		variables[`pack_${n}_battery_state`] = { name: `Pack ${n} Battery State` }
		variables[`pack_${n}_runtime`] = { name: `Pack ${n} Runtime Remaining (H:MM)` }
		variables[`pack_${n}_runtime_minutes`] = { name: `Pack ${n} Runtime Remaining (minutes)` }
		variables[`pack_${n}_health`] = { name: `Pack ${n} Battery Health (%)` }
		variables[`pack_${n}_cycles`] = { name: `Pack ${n} Battery Cycle Count` }
		variables[`pack_${n}_state`] = { name: `Pack ${n} Device State` }
	})

	this.setVariableDefinitions(variables)

	const values = {}
	for (const ch of this.api.getChannels()) {
		const n = ch.index + 1
		values[`ch_${n}_name`] = ch.name
		values[`ch_${n}_mute`] = ch.muted ? 'Muted' : 'Unmuted'
		values[`ch_${n}_gain`] = ch.gain ?? ''
	}
	this.setVariableValues(values)

	// pack battery values are published by the API client, which owns their state
	this.api.publishPackVariables()
}
