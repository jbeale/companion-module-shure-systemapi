/**
 * Upgrade scripts. Once added, an entry can never be removed or reordered.
 */
export const UpgradeScripts = [
	/**
	 * v0.1.0 -> v0.2.0: the separate `deviceMode` / `deviceId` pair was replaced by
	 * a single `device` picker, where 'auto' means "first ADTQ/ADTD found" and any
	 * other value is a device ID.
	 *
	 * @param {Object} _context - upgrade context
	 * @param {Object} props - config/actions/feedbacks to migrate
	 * @returns {Object} the migration result
	 */
	function migrateDeviceSelection(_context, props) {
		const config = props.config

		if (!config || config.device !== undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		if (config.deviceMode === undefined && config.deviceId === undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		const id = String(config.deviceId ?? '').trim()
		config.device = config.deviceMode === 'id' && id.length > 0 ? id : 'auto'

		delete config.deviceMode
		delete config.deviceId

		return { updatedConfig: config, updatedActions: [], updatedFeedbacks: [] }
	},
]
