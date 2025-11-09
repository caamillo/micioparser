import { Elysia, sse } from 'elysia'
import { cors } from '@elysiajs/cors'
import { Scraper } from "../src/scraper.js"
import { ContextMode } from "../src/navigation.js"
import log from '../src/log.js'

const DEFAULT_OPTIONS = {
    concurrency: 5,
    tasksPerWorker: 5,
}

let globalExecution = Scraper.withOptions(DEFAULT_OPTIONS)

function createAsyncQueue() {
    const buffer = []
    let resolver = null
    let isClosed = false

    return {
        push(item) {
            if (!resolver) {
                buffer.push(item)
                return
            }
            resolver({ value: item, done: false })
            resolver = null
        },
        close() {
            isClosed = true
            if (resolver) {
                resolver({ value: undefined, done: true })
                resolver = null
            }
        },
        async next() {
            if (buffer.length > 0) {
                return { value: buffer.shift(), done: false }
            }
            if (isClosed) {
                return { value: undefined, done: true }
            }
            return await new Promise(resolve => {
                resolver = resolve
            })
        },
        [Symbol.asyncIterator]() {
            return this
        }
    }
}

async function* streamQueue(queue, context = 'operation') {
    try {
        for await (const item of queue) {
            if (!item) continue
            const { event = 'message', data = {} } = item
            if (event === 'message' || event === 'end' || event === 'error') {
                yield {
                    event,
                    data: JSON.stringify(data)
                }
            }
            if (event === 'end' || event === 'error') {
                break
            }
        }
    } catch (error) {
        log.error(`Stream error in ${context}`, error)
        yield {
            event: 'error',
            data: JSON.stringify({
                success: false,
                error: `Stream interrupted: ${error.message}`
            })
        }
    }
}

const app = new Elysia()
    .use(cors())

    .get('/health', () => {
        const status = globalExecution.getStatus()
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            system: {
                initialized: status.initialized,
                drivers: status.drivers?.size || 0,
                workers: status.workers?.size || 0,
                contextMode: status.options?.contextMode
            }
        }
    })

    .get('/setup/:concurrency', async ({ params: { concurrency }, query, set }) => {
        concurrency = parseInt(concurrency)
        if (isNaN(concurrency) || concurrency < 1) {
            set.status = 400
            return {
                success: false,
                error: "Invalid size. Must be a positive integer."
            }
        }
        try {
            const connectors = query.connectors 
                ? query.connectors.split(',')
                : ['mangaworld', 'mangadex']
            const contextMode = query.context === 'single' 
                ? ContextMode.SINGLE 
                : query.context === 'multi'
                ? ContextMode.MULTI
                : null
            log.info('Setting up execution system', { 
                concurrency: concurrency,
                connectors,
                contextMode: contextMode || 'auto-detect'
            })
            if (globalExecution.isValid()) {
                await globalExecution.dispose()
            }
            globalExecution = Scraper.withOptions({
                concurrency: concurrency,
                contextMode
            })
            const driverConfigs = connectors.map(conn => [conn, 'chromium', null])
            await globalExecution.withDrivers(driverConfigs)
            const status = globalExecution.getStatus()
            log.success('Execution system initialized', {
                workers: status.workers.concurrency,
                drivers: status.drivers.size,
                contextMode: status.options.contextMode
            })
            return {
                success: true,
                message: `Initialized with ${concurrency} workers`,
                system: {
                    concurrency,
                    connectors,
                    contextMode: status.options.contextMode,
                    drivers: status.drivers,
                    workers: status.workers
                }
            }
        } catch (error) {
            log.error('Setup failed', error)
            set.status = 500
            return {
                success: false,
                error: `Setup failed: ${error.message}`
            }
        }
    })

    .get('/search/:title', async ({ params: { title }, query, set }) => {
        const { connector = '*', sequential = 'false', deep = 'true' } = query
        const queue = createAsyncQueue()

        if (!title) {
            queue.push({
                event: 'error',
                data: {
                    success: false,
                    error: 'Missing required parameter: title'
                }
            })
            queue.close()
            return sse(streamQueue(queue, 'search'))
        }

        const jobExecution = globalExecution.copy()
        jobExecution.opt.onItem = item => {
            queue.push(item)
        }

        ;(async () => {
            try {
                log.info('Starting search', { title, connector })
                const results = await jobExecution.search(
                    title,
                    connector,
                    { 
                        sequential: sequential === 'true', 
                        deep: deep === 'true' 
                    }
                )
                const totalResults = results.reduce(
                    (sum, r) => sum + (r.count || 0),
                    0
                )
                // queue.push({
                //     event: 'end',
                //     data: {
                //         success: true,
                //         totalResults,
                //         connectors: results.length
                //     }
                // })
            } catch (error) {
                log.error('Search failed', error, { title })
                queue.push({
                    event: 'error',
                    data: {
                        success: false,
                        error: error.message
                    }
                })
            } finally {
                queue.close()
            }
        })()
        return sse(streamQueue(queue, 'search'))
    })

    .get('/book', async ({ query, set }) => {
        const { url, connector } = query
        if (!url || !connector) {
            set.status = 400
            return {
                success: false,
                error: 'Missing required parameters: url, connector'
            }
        }
        try {
            log.info('Fetching book details', { url, connector })
            if (!globalExecution.isValid()) {
                await globalExecution.withDrivers([[connector, 'chromium', null]])
            }
            const fields = [
                'title',
                'alternative_titles',
                'banner',
                'author',
                'artist',
                'genres',
                'status',
                'year',
                'plot'
            ]
            const bookData = await globalExecution.drivers.exec(connector, async (driver) => {
                await driver.page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                })
                const data = { url }
                for (const field of fields) {
                    try {
                        data[field] = await driver.getEntryField(field)
                    } catch (error) {
                        log.debug(`Could not get field ${field}`, { error: error.message })
                        data[field] = null
                    }
                }
                return data
            })
            log.success('Book details fetched', { url })
            return {
                success: true,
                book: bookData
            }
        } catch (error) {
            log.error('Failed to fetch book', error, { url, connector })
            set.status = 500
            return {
                success: false,
                error: `Failed to fetch book: ${error.message}`
            }
        }
    })

    .get('/process', async ({ query, set }) => {
        let {
            url,
            connector,
            title,
            mode = 'parallel',
            concurrency
        } = query
        const queue = createAsyncQueue()
        if (!url) {
            queue.push({
                event: 'error',
                data: {
                    success: false,
                    error: 'Missing required parameter: url'
                }
            })
            queue.close()
            return sse(streamQueue(queue, 'process'))
        }
        concurrency = concurrency ? parseInt(concurrency) : null
        if (concurrency && (isNaN(concurrency) || concurrency < 1)) {
            queue.push({
                event: 'error',
                data: {
                    success: false,
                    error: 'Invalid size value'
                }
            })
            queue.close()
            return sse(streamQueue(queue, 'process'))
        }

        const jobExecution = globalExecution.copy()
        jobExecution.opt.onItem = item => {
            queue.push(item)
        }

        if (!globalExecution.isValid()) {
            const detectedConnector = connector || 'mangaworld'
            try {
                await globalExecution.withDrivers([[detectedConnector, 'chromium', null]])
            } catch (error) {
                queue.push({
                    event: 'error',
                    data: {
                        success: false,
                        error: `Initialization failed: ${error.message}`
                    }
                })
                queue.close()
                return sse(streamQueue(queue, 'process'))
            }
        }

        ;(async () => {
            try {
                log.info('Starting process', {
                    url,
                    mode,
                    concurrency: concurrency || globalExecution.opt.concurrency
                })
                const results = await jobExecution.process('default', mode, {
                    target: url,
                    title: title || 'unknown',
                    concurrency: concurrency
                })
                log.success('Process completed', {
                    url,
                    chaptersProcessed: results.length
                })
                queue.push({
                    event: 'end',
                    data: {
                        success: true,
                        chaptersProcessed: results.length
                    }
                })
            } catch (error) {
                log.error('Process failed', error, { url })
                queue.push({
                    event: 'error',
                    data: {
                        success: false,
                        error: error.message
                    }
                })
            } finally {
                queue.close()
            }
        })()
        return sse(streamQueue(queue, 'process'))
    })

    .get('/status', () => {
        const status = globalExecution.getStatus()
        if (!status.initialized) {
            return {
                initialized: false,
                message: 'System not initialized. Use /setup endpoint first.'
            }
        }
        return {
            initialized: true,
            options: status.options,
            drivers: status.drivers,
            workers: status.workers,
            navigation: status.navigation
        }
    })

    .post('/config/context', async ({ query, set }) => {
        const { mode } = query
        if (!mode || !['single', 'multi', 'auto'].includes(mode)) {
            set.status = 400
            return {
                success: false,
                error: 'Invalid mode. Must be: single, multi, or auto'
            }
        }
        try {
            const contextMode = mode === 'single'
                ? ContextMode.SINGLE
                : mode === 'multi'
                ? ContextMode.MULTI
                : null
            globalExecution.setOption('contextMode', contextMode || ContextMode.SINGLE)
            log.info('Context mode changed', { mode })
            return {
                success: true,
                contextMode: globalExecution.opt.contextMode
            }
        } catch (error) {
            log.error('Failed to change context mode', error)
            set.status = 500
            return {
                success: false,
                error: error.message
            }
        }
    })

    .post('/config/concurrency', async ({ query, set }) => {
        let { concurrency } = query
        concurrency = parseInt(concurrency)
        if (isNaN(concurrency) || concurrency < 1) {
            set.status = 400
            return {
                success: false,
                error: 'Invalid concurrency. Must be a positive integer.'
            }
        }
        try {
            globalExecution.setOption('size', concurrency)
            log.info('Worker pool size changed', { concurrency })
            return {
                success: true,
                concurrency
            }
        } catch (error) {
            log.error('Failed to change worker pool concurrency', error)
            set.status = 500
            return {
                success: false,
                error: error.message
            }
        }
    })

    .post('/shutdown', async ({ set }) => {
        try {
            log.info('Shutting down API')
            if (globalExecution.isValid()) {
                await globalExecution.dispose()
            }
            log.success('Cleanup complete')
            return {
                success: true,
                message: 'API shutting down'
            }
        } catch (error) {
            log.error('Shutdown error', error)
            set.status = 500
            return {
                success: false,
                error: error.message
            }
        }
    })

    .listen(3006, ({ hostname, port }) => {
        log.info(`API server started`, {
            url: `http://${hostname}:${port}`,
            endpoints: [
                'GET /health',
                'GET /status',
                'GET /setup/:concurrency?connectors=...&context=...',
                'GET /search/:title?connector=...&deep=...',
                'GET /book?url=...&connector=...',
                'GET /process?url=...&mode=...&concurrency=...',
                'POST /config/context?mode=...',
                'POST /config/concurrency?concurrency=...',
                'POST /shutdown'
            ]
        })
    })