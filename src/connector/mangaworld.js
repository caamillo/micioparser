import { childText, childrenText, childAttribute, Url } from "../utils.js"

const ENDPOINT_URL = 'https://mangaworld.cx' 
const CDN_ENDPOINT_URL = 'https://cdn.mangaworld.cx'

export default (driver) => ({
    ...driver,
    name: 'mangaworld',

    search: async (title) => {
        let url = new Url(ENDPOINT_URL, ["archive"], "", {
            "keyword": title,
            "page": 1
        })

        await driver.page.goto(url.render())
        const pages = parseInt(await (await driver.page.$('.page-item.last > a.page-link')).textContent())
        const results = []

        for (let i = 0; i < pages; i++) {
            url = new Url(ENDPOINT_URL, ["archive"], "", {
                "keyword": title,
                "page": i + 1
            })
            console.log(url.render())
            await driver.page.goto(url.render())
            const entries = await driver.page.$$('.comics-grid > .entry')
            results.push(...await Promise.all(
                entries.map(async entry => ({
                    link: await childAttribute(entry, 'a.thumb', 'href'),
                    banner: await childAttribute(entry, 'a.thumb > img', 'src'),
                    title: await childText(entry, '.manga-title'),
                    type: await childText(entry, '.genre > a'),
                    author: await childText(entry, '.author > a'),
                    artist: await childText(entry, '.artist > a'),
                    genres: await childrenText(entry, '.genres > a'),
                    short_plot: await entry.$eval('.story', el => {
                        const clone = el.cloneNode(true)
                        clone.querySelector('span').remove()
                        return clone.textContent.trim()
                    })
                }))
            ))
        }
        
        console.log('Done!')
        return results
    },

    getBookStructure: async (book) => {
        await driver.go(book)
        const firstCh = Url.fromString(await (await driver.page.$('.volume-element:last-child > div > div:last-child a')).getAttribute('href'))

        if (firstCh) await driver.page.goto(firstCh.render())
        else throw new Error("First charapter not found.")

        let page = Url.fromString(await (await driver.page.$('#page .img-fluid')).getAttribute('src'))
        page.editRoute(2, { type: "counter" })
        page.editRoute(3, { type: "counter" })
        const MAX_TO_INC = 10

        const resetParams = () =>
            [ true, true, Array(2).fill(MAX_TO_INC), true ]
        let [ tryVolumes, tryChapters, toInc, firstIter ] = resetParams()
        const resetLocal = () => {
            [
                tryVolumes,
                tryChapters,
                toInc,
                firstIter    // Has Volume Changed?
            ] = resetParams()
        }

        while (page) {
            try {
                console.log('a')
                const res = await driver.page.goto(page.render())
                console.log("trying:", page.render())
                if (!res.ok()) throw ""
                resetLocal()
                console.log('Page', page.render(), 'works!')
                page.incFile()
                await driver.page.screenshot({ path: 'out.png', fullPage: true })
            } catch {
                console.log(toInc, tryChapters, tryVolumes)
                console.log('firstIter', firstIter)
                const [ _a, _b, volume, chapter ] = page.routes
                let modifying

                if (tryChapters) {
                    modifying = chapter
                    if (toInc[0]) {
                        chapter.inc()
                        toInc[0]--
                    } else {
                        tryChapters = false
                        toInc = Array(2).fill(MAX_TO_INC)
                        firstIter = true
                        console.log('firstIter', firstIter)
                        modifying = volume
                        chapter.inc(-MAX_TO_INC)
                    }
                } else if (tryVolumes) {
                    modifying = volume
                    if (toInc[0] || toInc[1]) {
                        console.log(1, 1, volume.value)
                        if (!toInc[0]) {
                            volume.inc();
                            chapter.inc(-MAX_TO_INC)
                            toInc[1]--;
                            toInc[0] = MAX_TO_INC
                        }
                        console.log(2, 2, volume.value)
                        chapter.inc()
                        toInc[0]--
                    } else tryVolumes = false
                } else {
                    page = null
                    continue
                }
                console.log('firstIter', firstIter)
                if (firstIter) {
                    page.resetFile()
                    let route = modifying.value
                    let idx = route.slice(route.indexOf('-') + 1)
                    idx = idx.slice(0, idx.indexOf('-'))
                    idx = String(parseInt(idx) + 1).padStart(2, 0)
                    console.log("!!!!!!!!!!!!!! CHANGED IDX TO", idx, "!!!!!!!!!!!!!!!!!")
                    modifying.edit({
                        value: modifying.value.slice(0, modifying.value.indexOf('-') + 1) + idx + modifying.value.slice(modifying.value.lastIndexOf('-'))
                    })
                    firstIter = false
                }
            }
        }
    },

    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})
