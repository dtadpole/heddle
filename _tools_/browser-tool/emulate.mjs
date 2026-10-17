/**
 * Emulation: the page's view of the device, the network and the reader's preferences.
 *
 * Every setting here is applied through the protocol's own emulation domains, not by injecting CSS or
 * JavaScript, so what the page's own `matchMedia` and network stack see changes — which is the whole
 * point of emulating it.
 */

/** Chrome DevTools' network presets, in bytes per second, as its own frontend defines them. */
const NETWORK_CONDITIONS = {
  'Slow 3G': { downloadThroughput: ((500 * 1000) / 8) * 0.8, uploadThroughput: ((500 * 1000) / 8) * 0.8, latency: 400 * 5 },
  'Fast 3G': { downloadThroughput: ((1.6 * 1000 * 1000) / 8) * 0.9, uploadThroughput: ((750 * 1000) / 8) * 0.9, latency: 150 * 3.75 },
  'Slow 4G': { downloadThroughput: ((1.6 * 1000 * 1000) / 8) * 0.9, uploadThroughput: ((750 * 1000) / 8) * 0.9, latency: 150 * 3.75 },
  'Fast 4G': { downloadThroughput: ((9 * 1000 * 1000) / 8) * 0.9, uploadThroughput: ((1.5 * 1000 * 1000) / 8) * 0.9, latency: 60 * 2.75 },
}

/** The media features this tool emulates, and the CSS name each one has. */
const MEDIA_FEATURES = {
  colorScheme: 'prefers-color-scheme',
  forcedColors: 'forced-colors',
  prefersContrast: 'prefers-contrast',
  prefersReducedMotion: 'prefers-reduced-motion',
}

/** Parse `1280x900x2,mobile,touch,landscape`. */
export function parseViewport(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('viewport needs the form <width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]')
  const [dimensions, ...tags] = value.split(',')
  const [width, height, deviceScaleFactor] = dimensions.split('x').map(Number)
  if (!Number.isFinite(width) || width <= 0) throw new Error(`invalid viewport width '${dimensions.split('x')[0]}'`)
  if (!Number.isFinite(height) || height <= 0) throw new Error(`invalid viewport height '${dimensions.split('x')[1]}'`)
  if (deviceScaleFactor !== undefined && (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0)) {
    throw new Error(`invalid device pixel ratio '${dimensions.split('x')[2]}'`)
  }
  return {
    width,
    height,
    deviceScaleFactor: deviceScaleFactor ?? 1,
    isMobile: tags.includes('mobile'),
    hasTouch: tags.includes('touch'),
    isLandscape: tags.includes('landscape'),
  }
}

/** Parse `37.7749,-122.4194`. */
export function parseGeolocation(value) {
  const [latitude, longitude] = String(value).split(',').map(Number)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`invalid latitude '${String(value).split(',')[0]}'`)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`invalid longitude '${String(value).split(',')[1]}'`)
  return { latitude, longitude }
}

/** Parse the JSON object a caller passes for extra headers. */
export function parseHeaders(value) {
  if (typeof value !== 'string') throw new Error('extraHttpHeaders must be a JSON string')
  if (value.trim().length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`extraHttpHeaders is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('extraHttpHeaders must be a JSON object')
  return parsed
}

/** The browser's own user agent, used to undo an override. */
async function defaultUserAgent(page) {
  const reply = await page.browser.connection.send('Browser.getVersion')
  return reply.result?.userAgent ?? ''
}

/**
 * Apply one complete emulation configuration.
 *
 * Like the harness's own tool, a call **replaces** the whole configuration except `extraHttpHeaders`:
 * omitting a field is how a caller turns it off, and a call that only changed what it named would make
 * the state depend on the history of calls.
 */
export async function emulate(page, options = {}, settings) {
  const state = settings			// the caller's mutable record of what is currently emulated
  const next = { ...state }

  if (options.networkConditions === undefined || options.networkConditions === null) {
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    delete next.networkConditions
  } else if (options.networkConditions === 'Offline') {
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    next.networkConditions = options.networkConditions
  } else {
    const condition = NETWORK_CONDITIONS[options.networkConditions]
    if (condition === undefined) throw new Error(`unknown network condition '${options.networkConditions}'`)
    await page.send('Network.emulateNetworkConditions', { offline: false, ...condition })
    next.networkConditions = options.networkConditions
  }

  if (options.cpuThrottlingRate === undefined || options.cpuThrottlingRate === 1 || options.cpuThrottlingRate === null) {
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    delete next.cpuThrottlingRate
  } else {
    const rate = Number(options.cpuThrottlingRate)
    if (!Number.isFinite(rate) || rate < 1 || rate > 20) throw new Error('cpuThrottlingRate must be between 1 and 20')
    await page.send('Emulation.setCPUThrottlingRate', { rate })
    next.cpuThrottlingRate = rate
  }

  if (options.geolocation === undefined || options.geolocation === null) {
    await page.send('Emulation.clearGeolocationOverride').catch(() => {})
    delete next.geolocation
  } else {
    const position = parseGeolocation(options.geolocation)
    /**
     * A geolocation override the page cannot read is not emulation. Granting the permission on the
     * browser context is best-effort: a browser without the grant still gets the coordinates, it just
     * also gets a permission prompt a headless page would never answer.
     */
    await page.browser.connection
      .send('Browser.grantPermissions', {
        permissions: ['geolocation'],
        ...(page.browserContextId !== undefined ? { browserContextId: page.browserContextId } : {}),
      })
      .catch(() => {})
    await page.send('Emulation.setGeolocationOverride', { ...position, accuracy: 1 })
    next.geolocation = options.geolocation
  }

  if (options.userAgent === undefined || options.userAgent === '') {
    await page.send('Emulation.setUserAgentOverride', { userAgent: await defaultUserAgent(page) })
    delete next.userAgent
  } else {
    await page.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent, acceptLanguage: 'en-US,en' })
    next.userAgent = options.userAgent
  }

  const features = []
  for (const [field, cssName] of Object.entries(MEDIA_FEATURES)) {
    const value = options[field]
    if (value === undefined || value === 'auto' || value === null) delete next[field]
    else {
      features.push({ name: cssName, value })
      next[field] = value
    }
  }
  await page.send('Emulation.setEmulatedMedia', { features })

  if (options.viewport === undefined || options.viewport === null) {
    await page.send('Emulation.clearDeviceMetricsOverride')
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    delete next.viewport
  } else {
    const viewport = parseViewport(options.viewport)
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.isMobile,
      screenOrientation: viewport.isLandscape
        ? { type: 'landscapePrimary', angle: 90 }
        : { type: 'portraitPrimary', angle: 0 },
    })
    await page.send('Emulation.setTouchEmulationEnabled', {
      enabled: viewport.hasTouch,
      /** The protocol refuses `maxTouchPoints: 0`; the count is only meaningful when touch is on. */
      ...(viewport.hasTouch ? { maxTouchPoints: 1 } : {}),
    })
    next.viewport = options.viewport
  }

  if (options.extraHttpHeaders !== undefined) {
    const headers = parseHeaders(options.extraHttpHeaders)
    await page.send('Network.setExtraHTTPHeaders', { headers })
    if (Object.keys(headers).length === 0) delete next.extraHttpHeaders
    else next.extraHttpHeaders = options.extraHttpHeaders
  }

  state.networkConditions = next.networkConditions
  state.cpuThrottlingRate = next.cpuThrottlingRate
  state.geolocation = next.geolocation
  state.userAgent = next.userAgent
  state.colorScheme = next.colorScheme
  state.forcedColors = next.forcedColors
  state.prefersContrast = next.prefersContrast
  state.prefersReducedMotion = next.prefersReducedMotion
  state.viewport = next.viewport
  state.extraHttpHeaders = next.extraHttpHeaders
  /** A field turned off is absent, not present and undefined: the record is what is emulated now. */
  for (const key of Object.keys(state)) if (state[key] === undefined) delete state[key]
  return { applied: Object.keys(state).sort() }
}

/** Resize the emulated viewport, which is what a page sees as its window. */
export async function resizePage(page, { width, height }) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) throw new Error('resize_page needs a positive width and height')
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  return { width: w, height: h }
}
