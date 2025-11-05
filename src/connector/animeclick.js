import { Url } from "../utils.js"
import log from "../log.js"

const ENDPOINT_URL = 'https://www.animeclick.it'

export default (driver) => ({
    ...driver,
    name: 'animeclick',

    getSearchUrl: (title) =>
        Url.fromString(ENDPOINT_URL + '/cerca?name=' + title),

    getSearchResults: async () => {
        const items = (await driver.page.$$('.row .media.item-search-item'))
            .filter(async item =>
                (await item.$$('ul > li')
                    .some(async row => (
                        await row.textContent()
                    )?.toLocaleLowerCase()?.includes('fumetto'))
            ))

        return items
    },

    getSearchEntryField: async(key, entry) => {
        const keys = {
            link: async () => await childAttribute(entry, 'a.thumb', 'href'),
            banner: async () => await childAttribute(entry, 'a.thumb > img', 'src'),
            title: async () => await childText(entry, '.manga-title'),
            type: async () => await childText(entry, '.genre > a'),
            author: async () => await childText(entry, '.author > a'),
            artist: async () => await childText(entry, '.artist > a'),
            genres: async () => await childrenText(entry, '.genres > a'),
            short_plot: async () => await entry.$eval('.story', el => {
                const clone = el.cloneNode(true)
                clone.querySelector('span').remove()
                return clone.textContent.trim()
            })
        }
        const getEntry = keys?.[key]
        if (!getEntry) return
        return await getEntry()
    },

    ENDPOINT_URL
})