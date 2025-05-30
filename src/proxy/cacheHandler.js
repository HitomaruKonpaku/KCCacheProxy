const { mapLimit } = require("async")
const { readFile, exists, unlink, ensureDir } = require("fs-extra")
const { join, dirname } = require("path")
const AdmZip = require("adm-zip")
const StreamZip = require("node-stream-zip")

module.exports = { verifyCache, mergeCache, createDiff, clearMain }

const { getConfig, getCacheLocation } = require("./config")
const Logger = require("./ipc")
const cacher = require("./cacher")

const logSource = "kccp-cacheHandler"

/**
 * Verifies cache, will delete if "delete" in argv or parameter set
 *
 * @param {boolean} [deleteInvalid] Delete invalid files
 */
async function verifyCache(deleteInvalid = process.argv.find(k => k.toLowerCase() == "delete")) {
    if (!getConfig().verifyCache) {
        Logger.error(logSource, "verifyCache is not set in config! Aborted check!")
        return
    }

    Logger.log(logSource, "Verifying cache... This might take a while")

    const responses = await mapLimit(
        Object.entries(cacher.getCached()),
        32,
        async ([key, value]) => {
            try {
                if (value.length == undefined) return 0
                const file = join(getCacheLocation(), key)
                const contents = await readFile(file)

                if (contents.length != value.length) {
                    Logger.error(logSource, key, "length doesn't match!", contents.length, value.length)
                    if (deleteInvalid) {
                        await unlink(file)
                        delete cacher.getCached()[key]
                    }
                    return 0
                }
                return 1
            } catch (e) {
                if (deleteInvalid)
                    delete cacher.getCached()[key]
                return -1
            }
        }
    )

    const total   = responses.length,
          invalid = responses.filter(k => k == 0).length,
          checked = responses.filter(k => k >= 0).length,
          error   = responses.filter(k => k == -1).length

    Logger.log(logSource, `Done verifying, found ${invalid} invalid files, ${checked} files checked, cached.json contains ${total} files, failed to check ${error} files (missing?)`)
}

/**
 * Merges specified folder in current cache
 * @param {string} source Folder to merge from
 */
async function mergeCache(source) {
    const zip = new StreamZip({
        file: source,
        storeEntries: true
    })

    zip.on("error", err => Logger.error(logSource, "An error occurred while reading zip file!", err))

    const fetchCached = new Promise((resolve, reject) => {
        let found = false
        zip.on("entry", entry => {
            if (entry.name.endsWith("cached.json") && !found) {
                Logger.log(logSource, "Found cached.json")
                found = true
                resolve({
                    baseFolder: entry.name.replace(/cached\.json$/, ""),
                    data: zip.entryDataSync(entry)
                })
            }
        })

        zip.on("ready", () => {
            if (!found)
                reject("Not found!")
            else
                Logger.log(logSource, "Zip loaded, extracting missing files...")
        })
    })

    const loadRest = new Promise(resolve => {
        zip.on("ready", resolve)
    })

    function unzip(entry, target) {
        return new Promise(resolve => {
            zip.extract(entry, target, resolve)
        })
    }

    try {
        const { baseFolder, data } = await fetchCached
        const newCached = JSON.parse(data)

        let completed = 0, lastPrint = Date.now()
        const total = Object.keys(newCached).length

        let newerLocally = 0, same = 0, copied = 0, skipped = 0, versionChange = 0
        for (const file of Object.keys(newCached).sort()) {
            completed++
            if (Date.now() - lastPrint > 10000) {
                Logger.log(logSource, `Current cache merge progress: ${(completed / total * 100).toFixed(1)}% (${completed.toLocaleString()}/${total.toLocaleString()})`)
                lastPrint = Date.now()
            }

            const newFile = newCached[file]
            const targetLocation = join(getCacheLocation(), file)

            if (cacher.getCached()[file] && await exists(targetLocation)) {
                const oldFile = cacher.getCached()[file]
                if (new Date(oldFile.lastmodified) > new Date(newFile.lastmodified)) {
                    newerLocally++
                    continue
                }
                if (oldFile.length == newFile.length && oldFile.lastmodified == newFile.lastmodified) {
                    if (oldFile.version == newFile.version)
                        same++
                    else {
                        versionChange++
                        cacher.getCached()[file] = newFile
                    }
                    continue
                }
            }

            await loadRest

            const sourceLocation = baseFolder + file.substring(1)

            const entry = zip.entry(sourceLocation)

            if (!entry) {
                // Logger.error(logSource, `File ${sourceLocation} is missing in zip`)
                skipped++
                break
            }

            if (await exists(targetLocation))
                await unlink(targetLocation)

            await ensureDir(dirname(targetLocation))
            await unzip(sourceLocation, targetLocation)
            cacher.getCached()[file] = newFile
            copied++
        }
        await cacher.forceSave()

        await loadRest
        zip.close()
        Logger.log(logSource, `Finished merging cache! Copied ${copied} files, updated version tag of ${versionChange} files. ${newerLocally} were newer locally, ${same} are the same, ${skipped} skipped.`)
    } catch (error) {
        return Logger.error(logSource, error)
    }
}
/**
 * Create a differential zip
 * @param {string} source Source zip/json to compare against
 * @param {string} target Target zip file
 */
async function createDiff(source, target) {
    Logger.log(logSource, source, "->", target)
    let oldCached

    if (source.endsWith(".zip")) {
        const zip = new StreamZip({
            file: source,
            storeEntries: true
        })

        oldCached = await new Promise((resolve, reject) => {
            zip.on("entry", entry => {
                if (entry.name.endsWith("cached.json")) {
                    Logger.log(logSource, "Found cached.json")
                    resolve(zip.entryDataSync(entry))
                    zip.close()
                }
            })
            zip.on("error", reject)
        })
    } else {
        oldCached = await readFile(source)
    }
    oldCached = JSON.parse(oldCached)

    const diffCached = {}
    const zip = new AdmZip()

    let olderCurrently = 0, same = 0, news = 0, total = 0, versionChange = 0
    for (const file of Object.keys(cacher.getCached()).sort()) {
        const newFile = cacher.getCached()[file]
        const oldFile = oldCached[file]

        if (oldFile) {
            if (new Date(oldFile.lastmodified) > new Date(newFile.lastmodified)) {
                olderCurrently++
                continue
            }
            if (oldFile.length == newFile.length && oldFile.lastmodified == newFile.lastmodified) {
                if (oldFile.version == newFile.version)
                    same++
                else {
                    versionChange++
                    diffCached[file] = newFile
                }
                continue
            }
        } else
            news++

        const sourceLocation = join(getCacheLocation(), file)
        zip.addFile(file.substring(1), await readFile(sourceLocation))

        diffCached[file] = newFile
        total++
    }
    zip.addFile("cached.json", JSON.stringify(diffCached))

    Logger.log(logSource, "Saving...")

    await ensureDir(dirname(target))
    zip.writeZip(target)

    Logger.log(logSource, `Finished creating diff! ${total} total changes, of which ${news} new files. ${versionChange} changed version. ${same} are exactly the same. ${olderCurrently} are newer in old cache?! `)
}

async function clearMain() {
    for (const key of cacher.invalidated) {
        const file = join(getCacheLocation(), key)
        if (await exists(file)) {
            await unlink(file)
            Logger.log(logSource, `Deleted ${file} - as it could potentially cause issues`)
        }
    }
}
