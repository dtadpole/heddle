import { isUtf8 } from 'node:buffer'

/**
 * The text forms of the tool's answers.
 *
 * They are the harness browser's own forms — `uid=1_0 RootWebArea "Example"`, `reqid=3 GET
 * http://… [200]`, `msgid=2 [warn] …` — because a model that has read one of them elsewhere should
 * not have to learn a second dialect for the same page.
 */

/** How many items a page of a listing holds when the caller named no size. */
export const DEFAULT_PAGE_SIZE = 20

/** Truncate text to `limit` characters, saying so. */
export function truncate(text, limit) {
  if (typeof text !== 'string') return text
  return text.length > limit ? `${text.slice(0, limit)}... <truncated>` : text
}

/**
 * Take one page out of a list.
 *
 * Naming an out-of-range page is not an error: it reports the first page and says so, which is more
 * useful than refusing the whole call over an index the caller can see is wrong.
 */
export function paginate(items, options = {}) {
  const total = items.length
  const { pageSize, pageIdx } = options
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : undefined
  const totalPages = size === undefined ? 1 : Math.max(1, Math.ceil(total / size))
  let currentPage = 0
  let invalidPage = false
  if (pageIdx !== undefined) {
    if (!Number.isInteger(pageIdx) || pageIdx < 0 || pageIdx >= totalPages) invalidPage = true
    else currentPage = pageIdx
  }
  const startIndex = size === undefined ? 0 : currentPage * size
  const pageItems = size === undefined ? items : items.slice(startIndex, startIndex + size)
  return {
    items: pageItems,
    pagination: {
      total,
      currentPage,
      totalPages,
      startIndex,
      endIndex: startIndex + pageItems.length,
      hasNextPage: size !== undefined && currentPage < totalPages - 1,
      hasPreviousPage: size !== undefined && currentPage > 0,
      invalidPage,
    },
  }
}

/** The header lines a paginated listing carries. */
export function paginationLines(pagination) {
  const lines = []
  if (pagination.invalidPage) lines.push('Invalid page number provided. Showing first page.')
  if (pagination.total > pagination.endIndex - pagination.startIndex || pagination.totalPages > 1) {
    lines.push(
      `Showing ${pagination.total === 0 ? 0 : pagination.startIndex + 1}-${pagination.endIndex} of ${pagination.total} (Page ${pagination.currentPage + 1} of ${pagination.totalPages}).`,
    )
  }
  return lines
}

/** `## Pages` and one numbered line per open page. */
export function formatPages(pages) {
  const lines = ['## Pages']
  for (const page of pages) {
    const label = page.title && page.title.length > 0 ? `${truncate(page.title, 80)} (${page.url})` : page.url
    lines.push(`${page.pageId}: ${label}${page.selected ? ' [selected]' : ''}`)
  }
  return lines.join('\n')
}

/** One console message in the concise form. */
export function formatConsoleMessage(message) {
  const countSuffix = message.count !== undefined && message.count > 1 ? ` [${message.count} times]` : ''
  const line = `msgid=${message.msgid} [${message.type}] ${message.text} (${message.argsCount ?? 0} args)${countSuffix}`
  if (message.stack === undefined || message.stack.length === 0) return line
  return `${line}\n${message.stack.map((entry) => `  ${entry}`).join('\n')}`
}

/** One console message in the detailed form `get_console_message` returns. */
export function formatConsoleMessageDetailed(message) {
  const lines = [`ID: ${message.msgid}`, `Message: ${message.type}> ${message.text}`, `### Arguments`]
  const args = message.args ?? []
  if (args.length === 0) lines.pop()
  else args.forEach((arg, index) => lines.push(`Arg #${index}: ${typeof arg === 'object' ? JSON.stringify(arg) : String(arg)}`))
  if (message.url !== undefined) lines.push(`Source: ${message.url}:${(message.line ?? 0) + 1}`)
  if (message.stack !== undefined && message.stack.length > 0) lines.push('### Stack trace', ...message.stack)
  return lines.join('\n')
}

/** Group consecutive identical messages, counting them, as DevTools' console does. */
export function groupConsoleMessages(messages) {
  const grouped = []
  for (const message of messages) {
    const previous = grouped[grouped.length - 1]
    if (previous !== undefined && previous.type === message.type && previous.text === message.text && (previous.argsCount ?? 0) === (message.argsCount ?? 0)) {
      previous.count = (previous.count ?? 1) + 1
      continue
    }
    grouped.push({ ...message, count: 1 })
  }
  return grouped
}

/** Messages of the live document, or of the last few documents too when preserved. */
export function currentConsoleMessages(page, includePreserved) {
  const current = page.browser.navigationEpoch
  const minimum = current - (includePreserved ? 3 : 0)
  return page.console.filter((message) => message.navigation >= minimum && (includePreserved || message.navigation === current || message.navigation === undefined))
}

/** `## Console messages` and the listing. */
export function formatConsoleList(page, options = {}) {
  const { pageSize, pageIdx, types, includePreservedMessages = false, includeStackTraces = false } = options
  let messages = currentConsoleMessages(page, includePreservedMessages)
  if (Array.isArray(types) && types.length > 0) messages = messages.filter((message) => types.includes(message.type))
  const withCounts = groupConsoleMessages(messages).map((message) => ({
    ...message,
    argsCount: message.args?.length ?? 0,
  }))
  const { items, pagination } = paginate(withCounts, { pageSize, pageIdx })
  const lines = ['## Console messages', ...paginationLines(pagination)]
  if (items.length === 0) lines.push('<no console messages found>')
  else {
    for (const message of items) {
      lines.push(formatConsoleMessage({ ...message, ...(includeStackTraces ? {} : { stack: undefined }) }))
    }
  }
  return { text: lines.join('\n'), messages: items, pagination }
}

/** The status column of a network request: the code, the failure, or that it is still running. */
export function networkStatus(entry) {
  if (entry.failed !== undefined) return entry.failed
  if (entry.status !== undefined) return String(entry.status)
  return 'pending'
}

/** One network request in the concise form. */
export function formatNetworkRequest(entry) {
  return `reqid=${entry.reqid} ${entry.method} ${truncate(entry.url, 255)} [${networkStatus(entry)}]`
}

/** The network requests of the live document, or of the last few documents too when preserved. */
export function currentNetworkRequests(page, includePreserved) {
  const current = page.browser.navigationEpoch
  const minimum = current - (includePreserved ? 3 : 0)
  return page.network.filter((entry) => (includePreserved ? entry.navigation >= minimum : entry.navigation === current || entry.navigation === undefined))
}

/** `## Network requests` and the listing. */
export function formatNetworkList(page, options = {}) {
  const { pageSize, pageIdx, includePreservedRequests = false } = options
  const entries = currentNetworkRequests(page, includePreservedRequests)
  const { items, pagination } = paginate(entries, { pageSize, pageIdx })
  const lines = ['## Network requests', ...paginationLines(pagination)]
  if (items.length === 0) lines.push('No requests found.')
  else for (const entry of items) lines.push(formatNetworkRequest(entry))
  return { text: lines.join('\n'), requests: items.map(networkToJson), pagination }
}

/** The JSON form of one request. */
export function networkToJson(entry) {
  return {
    reqid: entry.reqid,
    method: entry.method,
    url: entry.url,
    status: networkStatus(entry),
    ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.duration !== undefined ? { duration: Math.round(entry.duration * 1000) } : {}),
  }
}

/** One request in the detailed form `get_network_request` returns. */
export async function formatNetworkRequestDetailed(page, entry, bodies) {
  const lines = [formatNetworkRequest(entry), `Status: ${networkStatus(entry)}`, '### Request Headers']
  for (const [name, value] of Object.entries(entry.requestHeaders ?? {})) lines.push(`- ${name}:${value}`)
  if (entry.postData !== undefined) lines.push('### Request Body', truncate(entry.postData, 10_000))
  if (entry.responseHeaders !== undefined) {
    lines.push('### Response Headers')
    for (const [name, value] of Object.entries(entry.responseHeaders)) lines.push(`- ${name}:${value}`)
  }
  if (bodies?.response !== undefined) lines.push('### Response Body', bodies.response)
  if (entry.failed !== undefined) lines.push('### Request failed with', entry.failed)
  return lines.join('\n')
}

/** A response body as text, when it is text. */
export function responseBodyText(body, base64Encoded) {
  if (body === undefined || body === null) return '<not available anymore>'
  if (base64Encoded !== true) return truncate(String(body), 10_000)
  const buffer = Buffer.from(body, 'base64')
  if (!isUtf8(buffer)) return '<binary data>'
  const text = buffer.toString('utf8')
  if (text.length === 0) return '<empty response>'
  return truncate(text, 10_000)
}
