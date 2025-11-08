export const childText = async (el, query) => {
    if (!el) return null
    const child = await el.$(query)
    if (!child) return null
    return await child.textContent()
}

export const childAttribute = async (el, query, attr) => {
    if (!el) return null
    const child = await el.$(query)
    if (!child) return null
    return await child.getAttribute(attr)
}

export const childAt = async (el, query, at, modifier = CommonModifiers.default, multiple = false) => {
    if (!el) return null
    el = await el.$(query)
    if (!el) return null

    if (!multiple) el = await el.$(at)
    else el = await el.$$(at)

    return await modifier(el)
}

export const childrenText = async (el, query) => {
    if (!el) return []
    const children = await el.$$(query)
    return Promise.all(children.map(async child => await child.textContent()))
}

export const childrenAt = async (el, query, at, modifier = CommonModifiers.default, multiple = false) => {
    if (!el) return []
    let els = await el.$$(query)

    if (!multiple) els = await Promise.all(els.map(async el => el?.$(at)))
    else els = await Promise.all(els.map(async el => el?.$$(at)))

    return await modifier(els)
}

export const CommonModifiers = {
    default: async (el) => el,
    textContent: async (el) => await el?.textContent()
}

const IndexPool = '0123456789abcdef'.split('')

class Route {
    constructor(pos, type = 'default') {
        this.value = pos
        this.type = type
    }

    inc(amount = 1, counter_regex = /(\d+(?!.*\d).*)$/) {
        if (this.type !== 'counter') return

        let idx = this.value.match(counter_regex)
        idx = idx ? idx[1] : null
        if (!idx) return

        idx = idx.toLowerCase()
        const base = IndexPool.length
        const width = idx.length

        let val = 0
        for (let ch of idx) {
            const d = IndexPool.findIndex(x => x === ch)
            if (d < 0) return
            val = val * base + d
        }

        const mod = Math.pow(base, width)
        let newVal = (val + amount) % mod
        if (newVal < 0) newVal += mod

        let newIdx = ''
        for (let i = 0; i < width; i++) {
            newIdx = IndexPool[newVal % base] + newIdx
            newVal = Math.floor(newVal / base)
        }

        this.value = this.value.slice(0, -width) + newIdx

        return
    }

    edit(args) {
        Object.assign(this, args)
    }
}

export class Url {
    constructor(domain = "", routes = [], file = "", args = {}) {
        this.domain = domain
        this.routes = routes
            .map(route => route instanceof Route ? route : new Route(route))
        this.file = file
        this.args = args
    }

    static fromString(url) {
        const instance = new Url()
        instance.parse(url)
        return instance
    }

    parse(url) {
        const re = /^(https?:\/\/[^\/\?#]+)(\/(?:[^\/\.\?#]+(?:\/[^\/\.\?#]+)*)?)?(\/[^\/\?#]+\.[^\/\?#]+)?(\?[^#]*)?$/
        const m = url.match(re)
        if (!m) throw new Error('invalid url format')
        const [domain, routesGroup, fileGroup, argsGroup] = m.slice(1)
        let routes, file, args
        if (routesGroup) {
            if (routesGroup.includes('.')) file = routesGroup
            else routes = routesGroup
        }
        if (fileGroup) {
            if (fileGroup.includes('.') && !file) file = fileGroup
            else args = fileGroup
        }
        if (argsGroup && !args) args = argsGroup

        // Reset all properties
        this.domain = domain
        this.routes = []
        this.file = ''
        this.args = {}

        if (routes) {
            routes.split('/').filter(route => route).forEach(route => this.addRoute(route))
        }

        if (file) this.setFile(file)
        if (args) this.AddArgs(
            Object.fromEntries(
                args.slice(1)
                    .split('&')
                    .map(arg => arg.split('='))
            )
        )

        return this
    }

    setDomain(url) {
        this.domain = url
    }

    addRoute(pos, type) {
        this.routes.push(new Route(pos, type))
    }

    incRoute(idx) {
        this.routes[idx].inc()
    }

    editRoute(idx, args) {
        this.routes[idx].edit(args)
    }

    getFileIndex() {
        const match = this.file.match(/\d+/)
        if (!match) return

        const n = parseInt(match[0])
        return n
    }

    setFile(file) {
        this.file = file
    }

    incFile() {
        if (!this.file) this.resetFile()

        const n = this.getFileIndex() + 1
        const ext = this.file.includes('.') ? this.file.slice(this.file.lastIndexOf('.')) : '.jpg'
        this.file = `/${n}${ext}`
    }

    resetFile() {
        const ext = this.file && this.file.includes('.') ? this.file.slice(this.file.lastIndexOf('.')) : '.jpg'
        this.file = `/${1}${ext}`
    }

    AddArgs(args) {
        this.args = { ...this.args, ...args }
    }

    incArg(key) {
        let value = this.args?.[key]
        if (isNaN(value)) return

        this.args[key] = parseInt(value) + 1
    }

    hasArg(key) {
        return key in this.args
    }

    render() {
        let url = this.domain

        const validRoutes = this.routes.filter(route => route.value)
        if (validRoutes.length) {
            url += '/' + validRoutes.map(route => route.value).join('/')
        }

        if (this.file && this.file.length) {
            url += this.file
        }

        if (Object.keys(this.args).length) {
            url += '?' + Object.entries(this.args)
                .map(([k, v]) => `${k}=${v}`)
                .join('&')
        }

        return url
    }

    display() {
        console.log(this)
    }
}

export class Proxy {
    constructor(server, user = "", pass = "") {
        this.server = server
        this.user = user
        this.pass = pass
    }

    isValid() {
        return !!this.server
    }
}

export class ProxyPool {
    constructor() {
        this.pool = []
        this.idx = 0
    }

    getProxy() {
        if (!this.pool.length) return null

        const proxy = this.pool[this.idx]
        this.idx = (this.idx + 1) % this.pool.length
        return proxy
    }

    addProxy(server, user = "", pass = "") {
        this.pool.push(new Proxy(server, user, pass))
    }

    addProxies(proxies) {
        proxies.map(([server, user, pass]) =>
            this.pool.push(new Proxy(server, user, pass))
        )
    }
}