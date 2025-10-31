import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import log from './log.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SETTINGS_PATH = join(__dirname, '..', 'settings.json')

const DEFAULT_SETTINGS = {
    drivers: {},
    lastUpdated: null
}

export class Settings {
    constructor() {
        this.data = { ...DEFAULT_SETTINGS }
        this.loaded = false
    }

    /**
     * Load settings from file
     */
    async load() {
        try {
            const content = await fs.readFile(SETTINGS_PATH, 'utf8')
            this.data = JSON.parse(content)
            this.loaded = true
            log.info('Settings loaded', { 
                driversConfigured: Object.keys(this.data.drivers || {}).length 
            })
        } catch (error) {
            if (error.code === 'ENOENT') {
                log.info('Settings file not found, creating new one')
                await this.save()
            } else {
                log.error('Failed to load settings', error)
                throw error
            }
        }
    }

    /**
     * Save settings to file
     */
    async save() {
        try {
            this.data.lastUpdated = new Date().toISOString()
            await fs.writeFile(
                SETTINGS_PATH, 
                JSON.stringify(this.data, null, 2),
                'utf8'
            )
            log.debug('Settings saved', { path: SETTINGS_PATH })
        } catch (error) {
            log.error('Failed to save settings', error)
            throw error
        }
    }

    /**
     * Get driver configuration
     * @param {string} driverName - Name of the driver (e.g., 'mangaworld')
     * @returns {Object|null} Driver configuration or null if not found
     */
    getDriverConfig(driverName) {
        if (!this.loaded) {
            log.warn('Settings not loaded yet')
            return null
        }

        const config = this.data.drivers?.[driverName]
        
        if (config) {
            log.debug('Driver configuration found', { 
                driver: driverName,
                reqsPerSecond: config.reqsPerSecond 
            })
        }
        
        return config || null
    }

    /**
     * Check if driver has configuration
     * @param {string} driverName - Name of the driver
     * @returns {boolean}
     */
    hasDriverConfig(driverName) {
        return !!this.data.drivers?.[driverName]
    }

    /**
     * Set driver configuration from rate limit test results
     * @param {string} driverName - Name of the driver
     * @param {Object} testStats - Stats from RateLimitTester
     */
    async setDriverConfig(driverName, testStats) {
        if (!this.data.drivers) {
            this.data.drivers = {}
        }

        const config = {
            reqsPerSecond: parseFloat(testStats.recommendedReqsPerSecond),
            lastSuccessfulRate: testStats.lastSuccessfulRate,
            avgResponseTime: testStats.avgResponseTime,
            totalRequests: testStats.totalRequests,
            successfulRequests: testStats.successfulRequests,
            failedRequests: testStats.failedRequests,
            safetyMargin: testStats.safetyMargin,
            testedAt: new Date().toISOString(),
            testDuration: testStats.totalDuration
        }

        this.data.drivers[driverName] = config

        await this.save()

        log.success('Driver configuration saved', {
            driver: driverName,
            reqsPerSecond: config.reqsPerSecond,
            avgResponseTime: config.avgResponseTime
        })
    }

    /**
     * Update existing driver configuration
     * @param {string} driverName - Name of the driver
     * @param {Object} updates - Partial configuration to update
     */
    async updateDriverConfig(driverName, updates) {
        if (!this.hasDriverConfig(driverName)) {
            log.warn('Driver configuration not found, creating new', { driver: driverName })
        }

        if (!this.data.drivers) {
            this.data.drivers = {}
        }

        this.data.drivers[driverName] = {
            ...this.data.drivers[driverName],
            ...updates,
            updatedAt: new Date().toISOString()
        }

        await this.save()

        log.info('Driver configuration updated', { 
            driver: driverName,
            updates: Object.keys(updates)
        })
    }

    /**
     * Remove driver configuration
     * @param {string} driverName - Name of the driver
     */
    async removeDriverConfig(driverName) {
        if (!this.hasDriverConfig(driverName)) {
            log.warn('Driver configuration not found', { driver: driverName })
            return
        }

        delete this.data.drivers[driverName]
        await this.save()

        log.info('Driver configuration removed', { driver: driverName })
    }

    /**
     * Get all driver configurations
     * @returns {Object}
     */
    getAllDriverConfigs() {
        return { ...this.data.drivers }
    }

    /**
     * Check if configuration is stale (older than specified days)
     * @param {string} driverName - Name of the driver
     * @param {number} maxAgeDays - Maximum age in days (default: 30)
     * @returns {boolean}
     */
    isConfigStale(driverName, maxAgeDays = 30) {
        const config = this.getDriverConfig(driverName)
        if (!config || !config.testedAt) return true

        const testedDate = new Date(config.testedAt)
        const now = new Date()
        const ageMs = now - testedDate
        const ageDays = ageMs / (1e3 * 60 * 60 * 24)

        return ageDays > maxAgeDays
    }

    /**
     * Reset all settings to default
     */
    async reset() {
        this.data = { ...DEFAULT_SETTINGS }
        await this.save()
        log.info('Settings reset to default')
    }
}

// Singleton instance
let settingsInstance = null

/**
 * Get or create settings instance
 * @returns {Promise<Settings>}
 */
export async function getSettings() {
    if (!settingsInstance) {
        settingsInstance = new Settings()
        await settingsInstance.load()
    }
    return settingsInstance
}

/**
 * Helper to get driver config with automatic loading
 * @param {string} driverName
 * @returns {Promise<Object|null>}
 */
export async function getDriverConfig(driverName) {
    const settings = await getSettings()
    return settings.getDriverConfig(driverName)
}

/**
 * Helper to save driver config with automatic loading
 * @param {string} driverName
 * @param {Object} testStats
 */
export async function saveDriverConfig(driverName, testStats) {
    const settings = await getSettings()
    await settings.setDriverConfig(driverName, testStats)
}