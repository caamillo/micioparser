const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    SUCCESS: 2,
    WARN: 3,
    ERROR: 4
}

const COLORS = {
    DEBUG: '\x1b[36m',   // Cyan
    INFO: '\x1b[34m',    // Blue
    SUCCESS: '\x1b[32m', // Green
    WARN: '\x1b[33m',    // Yellow
    ERROR: '\x1b[31m',   // Red
    RESET: '\x1b[0m'
}

const ICONS = {
    DEBUG: '🔍',
    INFO: 'ℹ️',
    SUCCESS: '✅',
    WARN: '⚠️',
    ERROR: '❌'
}

class Logger {
    constructor() {
        this.debugEnabled = process.env.DEBUG === 'true' || process.env.DEBUG === '1'
        this.minLevel = this.debugEnabled ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO
    }

    _formatMessage(level, message, context = {}) {
        const timestamp = new Date().toISOString()
        const color = COLORS[level]
        const icon = ICONS[level]
        const reset = COLORS.RESET
        
        let contextStr = ''
        if (Object.keys(context).length > 0) {
            contextStr = ' ' + JSON.stringify(context)
        }

        return `${color}${icon} [${timestamp}] [${level}]${reset} ${message}${contextStr}`
    }

    _log(level, message, context = {}) {
        if (LOG_LEVELS[level] < this.minLevel) return

        const formattedMessage = this._formatMessage(level, message, context)
        
        if (level === 'ERROR') {
            console.error(formattedMessage)
        } else if (level === 'WARN') {
            console.warn(formattedMessage)
        } else {
            console.log(formattedMessage)
        }
    }

    debug(message, context = {}) {
        this._log('DEBUG', message, context)
    }

    info(message, context = {}) {
        this._log('INFO', message, context)
    }

    success(message, context = {}) {
        this._log('SUCCESS', message, context)
    }

    warn(message, context = {}) {
        this._log('WARN', message, context)
    }

    error(message, error = null, context = {}) {
        const errorContext = {
            ...context,
            ...(error && {
                error: error.message,
                stack: error.stack
            })
        }
        this._log('ERROR', message, errorContext)
    }

    chapterStart(chapterIndex, url) {
        this.info(`Starting chapter ${chapterIndex}`, { url })
    }

    chapterPage(chapterIndex, pageNum, url) {
        this.debug(`Chapter ${chapterIndex}, Page ${pageNum}`, { url })
    }

    chapterComplete(chapterIndex, pageCount) {
        this.success(`Completed chapter ${chapterIndex}`, { pages: pageCount })
    }

    chapterError(chapterIndex, error, url) {
        this.error(`Failed chapter ${chapterIndex}`, error, { url })
    }

    scrapeSuccess(url, stats) {
        this.success('Page scraped successfully', { url, ...stats })
    }

    scrapeAttempt(url, error, stats) {
        this.debug('Scrape attempt failed, retrying...', { url, reason: error, ...stats })
    }

    scrapeComplete(stats) {
        this.success('Scraping completed', stats)
    }

    navigationError(url, error) {
        this.error('Navigation failed', error, { url })
    }

    routeError(message, route) {
        this.error('Route processing error', new Error(message), { route })
    }
}

export const log = new Logger()
export default log