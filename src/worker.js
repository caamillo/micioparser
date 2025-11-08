import log from "./log.js"

/**
 * Manages pending tasks
 */
export class TaskQueue {
    constructor() {
        this.queue = []
        this.waiters = []
    }

    /**
     * Add task to queue
     */
    enqueue(task) {
        if (this.waiters.length > 0) {
            const resolve = this.waiters.shift()
            resolve(task)
        } else {
            this.queue.push(task)
        }
    }

    /**
     * Get next task (waits if queue is empty)
     */
    async dequeue() {
        if (this.queue.length > 0) {
            return this.queue.shift()
        }

        return new Promise(resolve => {
            this.waiters.push(resolve)
        })
    }

    /**
     * Get queue size
     */
    size() {
        return this.queue.length
    }

    /**
     * Check if queue is empty
     */
    isEmpty() {
        return this.queue.length === 0 && this.waiters.length === 0
    }

    /**
     * Clear all pending tasks
     */
    clear() {
        this.queue = []
        // Resolve all waiters with null (poison pill)
        this.waiters.forEach(resolve => resolve(null))
        this.waiters = []
    }
}

/**
 * Executes tasks from queue
 */
class Worker {
    constructor(id, taskQueue, navigationLock) {
        this.id = id
        this.taskQueue = taskQueue
        this.navigationLock = navigationLock
        this.running = false
        this.currentTask = null
        this.stats = {
            tasksCompleted: 0,
            tasksError: 0,
            totalTime: 0
        }
    }

    /**
     * Start worker loop
     */
    async start() {
        this.running = true
        log.debug('Worker started', { workerId: this.id })

        while (this.running) {
            try {
                // Get next task (blocks if queue empty)
                const task = await this.taskQueue.dequeue()

                if (!task || !this.running) {
                    break
                }

                this.currentTask = task

                const startTime = Date.now()
                
                try {
                    // Execute task
                    await this._executeTask(task)
                    
                    this.stats.tasksCompleted++
                    this.stats.totalTime += Date.now() - startTime
                } catch (error) {
                    this.stats.tasksError++
                    log.error('Task execution failed', error, {
                        workerId: this.id,
                        taskType: task.type
                    })
                    
                    // Propagate error to task
                    if (task.reject) {
                        task.reject(error)
                    }
                }

                this.currentTask = null
            } catch (error) {
                log.error('Worker loop error', error, { workerId: this.id })
            }
        }

        log.debug('Worker stopped', { 
            workerId: this.id,
            stats: this.stats
        })
    }

    /**
     * Execute a single task
     */
    async _executeTask(task) {
        log.debug('Worker executing task', {
            workerId: this.id,
            taskType: task.type,
            connector: task.connector
        })

        // Acquire navigation lock if task requires page navigation
        if (task.requiresNavigation) {
            await this.navigationLock.acquire(task.connector)
        }

        try {
            // Execute task function
            const result = await task.execute()

            // Resolve task promise
            if (task.resolve) {
                task.resolve(result)
            }

            return result
        } finally {
            // Release navigation lock
            if (task.requiresNavigation) {
                this.navigationLock.release(task.connector)
            }
        }
    }

    /**
     * Stop worker
     */
    stop() {
        this.running = false
    }

    /**
     * Get worker status
     */
    getStatus() {
        return {
            id: this.id,
            running: this.running,
            busy: !!this.currentTask,
            currentTask: this.currentTask ? {
                type: this.currentTask.type,
                connector: this.currentTask.connector
            } : null,
            stats: { ...this.stats }
        }
    }
}

/**
 * Manages worker threads
 */
export class WorkerPool {
    constructor(size, navigationLock) {
        this.size = size
        this.taskQueue = new TaskQueue()
        this.navigationLock = navigationLock
        this.workers = []
        this.running = false
    }

    /**
     * Start all workers
     */
    async start() {
        if (this.running) {
            log.warn('Worker pool already running')
            return
        }

        this.running = true

        // Create and start workers
        for (let i = 0; i < this.size; i++) {
            const worker = new Worker(i, this.taskQueue, this.navigationLock)
            this.workers.push(worker)
            
            // Start worker (non-blocking)
            worker.start().catch(error => {
                log.error('Worker crashed', error, { workerId: i })
            })
        }

        log.success('Worker pool started', { 
            workerCount: this.size 
        })
    }

    /**
     * Submit task to queue
     */
    async submit(task) {
        if (!this.running) {
            throw new Error('Worker pool not started')
        }

        return new Promise((resolve, reject) => {
            // Attach promise handlers to task
            task.resolve = resolve
            task.reject = reject

            // Enqueue task
            this.taskQueue.enqueue(task)

            log.debug('Task submitted', {
                taskType: task.type,
                connector: task.connector,
                queueSize: this.taskQueue.size()
            })
        })
    }

    /**
     * Submit multiple tasks and wait for all
     */
    async submitAll(tasks) {
        return Promise.all(tasks.map(task => this.submit(task)))
    }

    /**
     * Stop all workers
     */
    async stop() {
        if (!this.running) return

        this.running = false

        // Stop all workers
        this.workers.forEach(worker => worker.stop())

        // Clear task queue (sends poison pills)
        this.taskQueue.clear()

        log.info('Worker pool stopped')
    }

    /**
     * Get pool status
     */
    getStatus() {
        return {
            size: this.size,
            running: this.running,
            queueSize: this.taskQueue.size(),
            workers: this.workers.map(w => w.getStatus()),
            busyWorkers: this.workers.filter(w => w.currentTask).length
        }
    }

    /**
     * Get aggregated stats
     */
    getStats() {
        const stats = {
            totalTasksCompleted: 0,
            totalTasksError: 0,
            totalTime: 0,
            avgTimePerTask: 0
        }

        this.workers.forEach(worker => {
            stats.totalTasksCompleted += worker.stats.tasksCompleted
            stats.totalTasksError += worker.stats.tasksError
            stats.totalTime += worker.stats.totalTime
        })

        if (stats.totalTasksCompleted > 0) {
            stats.avgTimePerTask = (stats.totalTime / stats.totalTasksCompleted).toFixed(0)
        }

        return stats
    }
}

/**
 * Creates different task types
 */
export class TaskFactory {
    /**
     * Create navigation task
     */
    static navigation(connector, url, options = {}) {
        return {
            type: 'navigation',
            connector,
            requiresNavigation: true,
            execute: options.execute,
            ...options
        }
    }

    /**
     * Create extraction task (no navigation needed)
     */
    static extraction(connector, options = {}) {
        return {
            type: 'extraction',
            connector,
            requiresNavigation: false,
            execute: options.execute,
            ...options
        }
    }

    /**
     * Create search task
     */
    static search(connector, title, options = {}) {
        return {
            type: 'search',
            connector,
            title,
            requiresNavigation: true,
            execute: options.execute,
            ...options
        }
    }

    /**
     * Create deep search task
     */
    static deepSearch(connector, title, item, options = {}) {
        return {
            type: 'deep_search',
            connector,
            title,
            item,
            requiresNavigation: true,
            execute: options.execute,
            ...options
        }
    }

    /**
     * Create chapter scrape task
     */
    static chapterScrape(connector, chapter, chapterIndex, options = {}) {
        return {
            type: 'chapter_scrape',
            connector,
            chapter,
            chapterIndex,
            requiresNavigation: true,
            execute: options.execute,
            ...options
        }
    }
}