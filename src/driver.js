import { chromium, devices } from "playwright"
import { Url } from "./utils.js"
import log from "./log.js"
import { ContextMode } from "./navigation.js"

import mangaworld from "./connector/mangaworld.js"
import mangadex from "./connector/mangadex.js"

export const Browsers = {
    chromium: {
        driver: chromium,
        deviceDisplayName: 'chrome'
    }
}

export const Connectors = {
    mangaworld,
    mangadex,
}

const driverApis = (page, connector) => ({
    page,
    Url,
    log,
    name: connector.name,
})

/**
 * Manages a single browser instance with connector
 */
export class Driver {
    constructor(connector_id, browserName, opt = {}) {
        this.connector_id = connector_id
        this.browserName = browserName
        this.opt = opt
        this.browser = null
        this.ctx = null
        this.page = null
        this.name = Connectors[connector_id]?.name || 'unknown'
        this.connector = null
        this.contextMode = opt.contextMode || ContextMode.SINGLE
    }

    isValid() {
        return !!this.connector && !!this.browser
    }

    /**
     * Rebuilds context with new proxy, if available
     */
    async build(proxy = this.opt.proxy) {
        // Launch browser if not exists (both SINGLE and MULTI modes need it)
        if (!this.browser) {
            const browserType = Browsers[this.browserName].driver
            this.browser = await browserType.launch()
            log.debug('Browser launched', { 
                connector: this.name,
                contextMode: this.contextMode 
            })
        } else if (this.contextMode === ContextMode.SINGLE) {
            // In SINGLE mode, warn if trying to rebuild with existing browser
            log.warn('Attempting to recreate context in single-context mode with browser already built.')
            return
        }

        // Close current context (MULTI mode will do this repeatedly)
        if (this.ctx) {
            await this.ctx.close()
            log.debug('Context closed', { connector: this.name })
        }

        // Create new context with proxy
        const contextOptions = {
            ...devices['chrome'],
            bypassCSP: true,
            ...(proxy && proxy.isValid() ? {
                proxy: {
                    server: `http://${proxy.server}`,
                    username: proxy.user,
                    password: proxy.pass,
                }
            } : {})
        }

        this.ctx = await this.browser.newContext(contextOptions)
        this.page = await this.ctx.newPage()

        // Update connector reference to new page
        const connectorFn = Connectors[this.connector_id]
        this.connector = {
            ...connectorFn(driverApis(this.page, connectorFn)),
            browser: this.browser,
            ctx: this.ctx
        }

        log.debug('Context created', { 
            connector: this.name,
            proxy: proxy?.server || 'none',
            contextMode: this.contextMode
        })
    }

    getConnector() {
        return this.connector
    }

    async close() {
        if (this.ctx) {
            await this.ctx.close()
            this.ctx = null
            this.page = null
        }
        
        if (this.browser) {
            await this.browser.close()
            this.browser = null
            this.connector = null
            log.debug('Driver closed', { connector: this.name })
        }
    }
}

/**
 * Manages multiple drivers (one per connector)
 */
export class DriverPool {
    constructor(opt = {}) {
        this.drivers = new Map() // connector_id -> Driver
        this.opt = { ...opt }
        this.contextMode = opt.contextMode || ContextMode.SINGLE
    }

    /**
     * Check if pool has any drivers
     */
    isValid() {
        return this.drivers.size > 0
    }

    /**
     * Get driver for connector
     */
    getDriver(connectorId) {
        return this.drivers.get(connectorId)
    }

    /**
     * Check if driver exists for connector
     */
    hasDriver(connectorId) {
        return this.drivers.has(connectorId)
    }

    /**
     * Add driver to pool
     */
    async addDriver(connector_id, browserName, proxy = null, opt = {}) {
        if (this.drivers.has(connector_id)) {
            log.warn('Driver already exists for connector', { connector: connector_id })
            return
        }

        const driver = new Driver(connector_id, browserName, {
            ...this.opt,
            ...opt,
            proxy,
            contextMode: this.contextMode
        })

        await driver.build()
        this.drivers.set(connector_id, driver)

        log.debug('Driver added to pool', {
            connector: driver.name,
            poolSize: this.drivers.size
        })
    }

    /**
     * Execute function with specific connector's driver
     */
    async exec(connectorId, fn) {
        const driver = this.getDriver(connectorId)
        
        if (!driver || !driver.isValid()) {
            throw new Error(`Driver not found or invalid: ${connectorId}`)
        }

        try {
            return await fn(driver.getConnector())
        } catch (err) {
            log.error('Driver execution error', err, { connector: connectorId })
            throw err
        }
    }

    /**
     * Rebuilds context for driver
     */
    async build(connectorId, proxy = null) {
        const driver = this.getDriver(connectorId)
        
        if (!driver) {
            throw new Error(`Driver not found: ${connectorId}`)
        }

        await driver.build(proxy)
    }

    /**
     * Get all connector IDs
     */
    getConnectorIds() {
        return Array.from(this.drivers.keys())
    }

    /**
     * Dispose all drivers
     */
    async dispose() {
        await Promise.all(
            Array.from(this.drivers.values()).map(driver => driver.close())
        )
        this.drivers.clear()
        log.info('Driver pool disposed')
    }

    /**
     * Get pool status
     */
    getStatus() {
        const drivers = {}
        this.drivers.forEach((driver, connectorId) => {
            drivers[connectorId] = {
                name: driver.name,
                valid: driver.isValid(),
                contextMode: driver.contextMode
            }
        })

        return {
            size: this.drivers.size,
            contextMode: this.contextMode,
            drivers
        }
    }

    /**
     * Create pool with specific connectors
     */
    static async withConnectors(connectorIds, options = {}) {
        const pool = new DriverPool(options)
        
        for (const connectorId of connectorIds) {
            const proxy = options.proxyPool?.getProxy() || null
            await pool.addDriver(connectorId, 'chromium', proxy, options)
        }

        return pool
    }

    /**
     * Create pool with all available connectors
     */
    static async withAllConnectors(options = {}) {
        const connectorIds = Object.keys(Connectors)
        return await DriverPool.withConnectors(connectorIds, options)
    }
}