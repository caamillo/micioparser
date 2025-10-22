export const childText = async (el, query) =>
    await (await el.$(query)).textContent()

export const childAttribute = async (el, query, attr) =>
    await (await el.$(query)).getAttribute(attr)

export const childrenText = async (el, query) => Promise.all(
    (await el.$$(query)).map(async child => await child.textContent())
)

const IndexPool = '0123456789abcdef'.split('')

class Route {
    constructor(pos, type='default') {
        this.value = pos
        this.type = type
    }

    inc(amount=1, counter_regex=/(\d+(?!.*\d).*)$/) {
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
    constructor(domain="", routes=[], file="", args={}) {
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
    setFile(file) {
        this.file = file
    }
    incFile() {
        if (!this.file) return

        let n = this.file.split('').filter(el => !isNaN(el)).join('')
        if (!n.length) return

        n = parseInt(n)
        n += 1

        this.file = '/' + n + this.file.slice(this.file.indexOf('.'))
    }
    resetFile() {
        if (!this.file) return

        let n = this.file.split('').filter(el => !isNaN(el)).join()
        if (!n.length) return

        this.file = '/' + 1 + this.file.slice(this.file.indexOf('.'))
    }
    AddArgs(args) {
        this.args = { ...this.args, ...args }
    }
    incArg(key) {
        let value = this.args?.[key]
        if (isNaN(value)) return

        this.args[key] = parseInt(value) + 1
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
    constructor() {
        this.server = undefined
        this.user = undefined
        this.pass = undefined
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
        if (!this.pool.length) return

        const proxy = this.pool[this.idx]
        this.idx = this.idx + 1 % this.pool.length
        return proxy
    }

    addProxy(server, user="", pass="") {
        this.pool.push(Proxy(server, user, pass))
    }

    addProxies(proxies) {
        proxies.map(([ server, user, pass ]) =>
            this.pool.push(Proxy(server, user, pass))
        )
    }
}