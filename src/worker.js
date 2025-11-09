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
    constructor(id, taskQueue, navigationLock, options = {}) {
        this.id = id
        this.taskQueue = taskQueue
        this.navigationLock = navigationLock
        this.tasksPerWorker = options.tasksPerWorker || 1
        this.running = false
        this.activeTasks = new Set()
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
        log.debug('Worker started', { 
            workerId: this.id, 
            tasksPerWorker: this.tasksPerWorker 
        })

        // Start multiple task processors based on tasksPerWorker
        const processors = []
        for (let i = 0; i < this.tasksPerWorker; i++) {
            processors.push(this._taskProcessor(i))
        }

        await Promise.all(processors)

        log.debug('Worker stopped', { 
            workerId: this.id,
            stats: this.stats
        })
    }

    /**
     * Runs in parallel (one per slot)
     */
    async _taskProcessor(slotId) {
        while (this.running) {
            try {
                // Get next task (blocks if queue empty)
                const task = await this.taskQueue.dequeue()

                if (!task || !this.running) {
                    break
                }

                // Track active task
                const taskId = `${this.id}-${slotId}-${Date.now()}`
                this.activeTasks.add(taskId)

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
                        slotId,
                        taskType: task.type
                    })
                    
                    // Propagate error to task
                    if (task.reject) {
                        task.reject(error)
                    }
                } finally {
                    this.activeTasks.delete(taskId)
                }
            } catch (error) {
                log.error('Worker processor error', error, { 
                    workerId: this.id, 
                    slotId 
                })
            }
        }
    }

    /**
     * Execute a single task
     */
    async _executeTask(task) {
        log.debug('Worker executing task', {
            workerId: this.id,
            taskType: task.type,
            connector: task.connector,
            activeTaskCount: this.activeTasks.size
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
            busy: this.activeTasks.size > 0,
            activeTasks: this.activeTasks.size,
            maxTasks: this.tasksPerWorker,
            stats: { ...this.stats }
        }
    }
}

/**
 * Manages worker threads
 */
export class WorkerPool {
    constructor(size, navigationLock, options = {}) {
        this.size = size
        this.taskQueue = new TaskQueue()
        this.navigationLock = navigationLock
        this.options = {
            tasksPerWorker: options.tasksPerWorker || 1
        }
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
            const worker = new Worker(
                i, 
                this.taskQueue, 
                this.navigationLock,
                { tasksPerWorker: this.options.tasksPerWorker }
            )
            this.workers.push(worker)
            
            // Start worker (non-blocking)
            worker.start().catch(error => {
                log.error('Worker crashed', error, { workerId: i })
            })
        }

        log.success('Worker pool started', { 
            workerCount: this.size,
            tasksPerWorker: this.options.tasksPerWorker,
            totalCapacity: this.size * this.options.tasksPerWorker
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
    getStatus() {
        const totalActiveTasks = this.workers.reduce(
            (sum, w) => sum + w.activeTasks.size, 
            0
        )
        const maxCapacity = this.size * this.options.tasksPerWorker

        return {
            size: this.size,
            running: this.running,
            queueSize: this.taskQueue.size(),
            tasksPerWorker: this.options.tasksPerWorker,
            totalCapacity: maxCapacity,
            activeTasks: totalActiveTasks,
            workers: this.workers.map(w => w.getStatus()),
            busyWorkers: this.workers.filter(w => w.activeTasks.size > 0).length
        }
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