import { childText, childrenText, childAttribute, Url } from "../utils.js"
import log from "../log.js"

const ENDPOINT_URL = 'https://mangadex.org'
const CDN_ENDPOINT_URL = 'https://mangadex.org'

export default (driver) => ({
    ...driver,
    name: 'mangadex',

    search: async (title) => {
        log.info('Starting manga search', { title, source: 'mangadex' })

        let url = new Url(ENDPOINT_URL, ['titles'], '', {
            q: title
        })

        await driver.page.goto(url.render())
        log.debug('Navigated to search page', { url: url.render() })

        const anchorsText = await childrenText(driver.page, '.flex.justify-center.flex-wrap.gap-2.mt-6 > a') || []
        let pages = 1
        if (anchorsText.length >= 2) {
            const maybe = anchorsText[anchorsText.length - 2]
            const parsed = parseInt(maybe)
            pages = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        }

        log.info('Found search result pages', { totalPages: pages, title })

        const results = []

        for (let i = 0; i < pages; i++) {
            url = new Url(ENDPOINT_URL, ['titles'], '', {
                q: title,
                page: i + 1
            })

            log.debug('Fetching search page', { page: i + 1, totalPages: pages, url: url.render() })
            await driver.page.goto(url.render())

            const entries = await driver.page.$$('.grid.gap-2.two-col > div') || []
            log.debug('Found entries on page', { page: i + 1, entriesCount: entries.length })

            const pageResults = await Promise.all(
                entries.map(async entry => {
                    try {
                        const href = await childAttribute(entry, 'a.title', 'href') || ''
                        const absolute = href.startsWith('http') ? href : (ENDPOINT_URL + href)
                        const banner = await childAttribute(entry, 'img.rounded.shadow-md.w-full.h-auto', 'src') || ''
                        const titleText = await childText(entry, 'a.title') || ''
                        const genres = await childrenText(entry, '.flex.flex-wrap.gap-1.tags-row.tags.self-start > *') || []
                        const shortPlot = await childText(entry, '.md-md-container.dense') || ''

                        return {
                            link: absolute,
                            banner,
                            title: titleText,
                            genres,
                            short_plot: shortPlot
                        }
                    } catch (error) {
                        log.error('Failed to parse entry', error, { page: i + 1 })
                        return null
                    }
                })
            )

            const validResults = pageResults.filter(r => r !== null)
            results.push(...validResults)

            log.success('Processed search page', {
                page: i + 1,
                totalPages: pages,
                resultsOnPage: validResults.length,
                totalResults: results.length
            })
        }

        log.success('Search completed', {
            title,
            totalResults: results.length,
            totalPages: pages
        })

        return results
    },

    getAllChapterLinks: async (opts = {}) => {
        log.debug('Retrieving all chapter links')

        const lang_idx = typeof opts.lang_idx === 'number' ? opts.lang_idx : 0
        try {
            await driver.page.waitForSelector('button.rounded.custom-opacity.relative.md-btn.text-sm > span', { timeout: 5000 })
            const idxBtns = await driver.page.$$('button.rounded.custom-opacity.relative.md-btn.text-sm > span')
            if (!idxBtns || idxBtns.length < 2) {
                log.debug('Index button not found or single button only, attempting alternative selector')
            } else {
                await idxBtns[1].click()
                await driver.page.waitForTimeout(300)
            }

            await driver.page.waitForSelector('.md-modal__box.flex-grow', { timeout: 5000 })
            const modal = await driver.page.$('.md-modal__box.flex-grow')
            if (!modal) {
                log.error('Modal not found after opening index')
                return []
            }

            const volumeLis = await modal.$$('ul > li') || []
            const links = []

            for (const vol of volumeLis) {
                const chapLis = await vol.$$('ul > li') || []
                for (const chap of chapLis) {
                    try {
                        const hasButton = await chap.$('button') || await chap.$('span')
                        console.log(hasButton)
                        if (hasButton) {
                            await hasButton.click().catch(() => {})
                            await driver.page.waitForTimeout(80)
                        }
                    } catch (e) {}

                    const langLis = await chap.$$('ul > li') || []
                    if (langLis.length === 0) continue

                    const chosen = langLis[lang_idx] || langLis[0]
                    const anchor = await chosen.$('a')
                    console.log(anchor)
                    if (anchor) {
                        const href = await anchor.getAttribute('href') || ''
                        const absolute = href.startsWith('http') ? href : ENDPOINT_URL + href
                        links.push(Url.fromString(absolute))
                    }
                }
            }

            const validLinks = links.filter(l => l)
            console.log(validLinks)
            log.success('Retrieved chapter links', { count: validLinks.length })

            return validLinks
        } catch (error) {
            log.error('Failed to get all chapter links', error)
            throw error
        }
    },

    getChapterLink: async () => {
        log.debug('Retrieving chapter image link')

        try {
            await driver.page.waitForSelector('#page img, .reader-img, img.img-fluid', { timeout: 5000 })
            const img = await driver.page.$('#page img') || await driver.page.$('.reader-img') || await driver.page.$('img.img-fluid')
            if (!img) {
                throw new Error('No chapter image element found')
            }
            const src = await img.getAttribute('src') || await img.getAttribute('data-src') || ''
            if (!src) {
                throw new Error('Image element found but src/data-src empty')
            }
            log.debug('Found chapter image', { src })
            return src
        } catch (error) {
            log.error('Failed to get chapter image link', error)
            throw error
        }
    },

    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})
