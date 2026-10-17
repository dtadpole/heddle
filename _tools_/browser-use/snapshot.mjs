/**
 * The accessibility snapshot, and the uids that make it an interface.
 *
 * A page can be driven by selectors, but a model cannot invent them. The harness's own browser tool
 * answers with a **text tree of the accessibility tree**, where every element carries a stable-looking
 * `uid` that the following `click`/`fill` names. That is what is reproduced here: the tree is a
 * reading of the page a person could also make (roles, names, states, nesting), and the uid is the
 * handle to act on it.
 *
 * The serialization follows Chrome DevTools' own text form, because a model that has seen that form
 * elsewhere does not have to learn a second one:
 *
 *     uid=1_0 RootWebArea "Example Domain" url="https://example.com/"
 *       uid=1_1 heading "Example Domain" level="1"
 *       uid=1_2 StaticText "This domain is for use in illustrative examples"
 */
import { Page } from './page.mjs'

/** Roles that are structure rather than content, and whose children are promoted into their place. */
const TRANSPARENT_ROLES = new Set(['none', 'presentation', 'InlineTextBox', 'LineBreak', 'ListMarker'])

/** Attributes that are the tree's own rather than things a reader would want printed. */
const EXCLUDED_ATTRIBUTES = new Set(['uid', 'role', 'name', 'children', 'backendNodeId', 'frameId', 'parentId', 'childIds'])

/**
 * Boolean attributes whose printed name differs from the protocol's.
 *
 * Chrome's accessibility tree names a state `disabled`, the DevTools text form names the *capability*
 * `disableable`; both are printed, and that is the form the harness's browser output has.
 */
const BOOLEAN_ATTRIBUTE_NAMES = {
  disabled: 'disableable',
  expanded: 'expandable',
  focused: 'focusable',
  selected: 'selectable',
}

/** The value a property must not carry to be worth printing. */
function isWorthPrinting(value) {
  return value !== false && value !== 'false' && value !== undefined && value !== null
}

/**
 * Take a snapshot of one page.
 *
 * Returns the tree and its text form, and **installs the uids on the page** so a later action can
 * resolve them. Uids are reused for the same node across snapshots of one document, so a caller that
 * held one does not lose it merely because a second snapshot was taken; a navigation clears them,
 * because the elements they named are gone.
 */
export async function takeSnapshot(page, { verbose = false } = {}) {
  await page.send('Accessibility.enable')
  const reply = await page.send('Accessibility.getFullAXTree', {})
  const nodes = reply.result.nodes ?? []
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes.find((node) => node.parentId === undefined || !byId.has(node.parentId))
  if (root === undefined) throw new Error('the page returned no accessibility tree')

  const snapshotId = page.uidSnapshotId + 1
  page.uidSnapshotId = snapshotId
  let counter = 0
  /** A frame and a backend node together name one element across snapshots of this document. */
  const keyOf = (node) => {
    const backend = node.backendDOMNodeId
    if (backend === undefined) return undefined
    return `${node.frameId ?? page.mainFrameId ?? ''}:${backend}`
  }

  /** The children of one protocol node, each built into a flat list of snapshot nodes. */
  const buildChildren = (node) =>
    (node.childIds ?? [])
      .map((childId) => byId.get(childId))
      .filter((child) => child !== undefined)
      .flatMap((child) => build(child))

  /**
   * One protocol node as snapshot nodes (none, one, or several when the node is promoted away).
   *
   * A promoted node contributes only its children — that is how an ignored wrapper becomes invisible
   * in the text tree without its contents disappearing.
   */
  const build = (node) => {
    const role = node.role?.value ?? ''
    const name = node.name?.value ?? ''
    const promote =
      node.ignored === true ||
      (TRANSPARENT_ROLES.has(role) && !(role === 'none' && name.length > 0)) ||
      (!verbose && role === 'generic' && name.length === 0)
    if (promote) return buildChildren(node)
    /** The parent is numbered before its children, so a reader numbers the tree the way it is printed. */
    const snapshotNode = makeNode(node, role, name)
    snapshotNode.children = buildChildren(node)
    return [snapshotNode]
  }

  const makeNode = (node, role, name) => {
    const key = keyOf(node)
    let uid = key !== undefined ? page.uidByKey.get(key) : undefined
    if (uid === undefined) {
      uid = `${snapshotId}_${counter++}`
      if (key !== undefined) page.uidByKey.set(key, uid)
    }
    const props = {}
    for (const property of node.properties ?? []) {
      const value = property?.value?.value
      if (property === undefined || property.name === undefined || !isWorthPrinting(value)) continue
      props[property.name] = value
    }
    // A text field's value, an option's value: part of what the element says, not of its markup.
    for (const field of ['value', 'description', 'keyshortcuts', 'roledescription']) {
      const value = node[field]?.value
      if (isWorthPrinting(value) && typeof value !== 'object') props[field] = value
    }
    page.uidToNode.set(uid, {
      backendNodeId: node.backendDOMNodeId,
      role,
      name,
      frameId: node.frameId,
    })
    return { uid, role, name, props }
  }

  const built = build(root)
  const snapshot =
    built.length === 1 ? built[0] : { uid: `${snapshotId}_root`, role: 'RootWebArea', name: '', props: {}, children: built }
  return { snapshotId, root: snapshot, text: formatSnapshot(snapshot, { verbose }) }
}

/** The text form of a snapshot tree, one line per node, two spaces per level. */
export function formatSnapshot(root, { verbose = false } = {}) {
  const lines = []
  const walk = (node, depth) => {
    lines.push(' '.repeat(depth * 2) + attributesOf(node).join(' '))
    if (!verbose && hasRedundantTextChildren(node)) return
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return lines.join('\n')
}

/**
 * Whether a node's children only repeat its name.
 *
 * A button named "Press" has a `StaticText` child that *is* the name; printing both says the same
 * thing twice. The comparison strips whitespace because the text nodes split on line breaks.
 */
function hasRedundantTextChildren(node) {
  if (node.name === undefined || node.name.length === 0) return false
  const children = node.children ?? []
  if (children.length === 0) return false
  let text = ''
  for (const child of children) {
    if (child.role !== 'StaticText' || (child.children?.length ?? 0) !== 0) return false
    text += child.name ?? ''
  }
  return text.replace(/\s+/g, '') === String(node.name).replace(/\s+/g, '')
}

/** One node as the attributes the text form prints. */
export function attributesOf(node) {
  const attributes = [`uid=${node.uid}`]
  if (node.role !== undefined && node.role.length > 0 && node.role !== 'StaticText') {
    attributes.push(node.role === 'none' ? 'ignored' : node.role)
  }
  if (node.name !== undefined && node.name.length > 0) attributes.push(`"${node.name}"`)
  const isOption = node.role === 'option'
  const props = node.props ?? {}
  /** The same rule Chrome's formatter uses: a renamed boolean is printed under both names. */
  const simple = {}
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'boolean') {
      if (BOOLEAN_ATTRIBUTE_NAMES[key] !== undefined) simple[BOOLEAN_ATTRIBUTE_NAMES[key]] = true
      if (value) simple[key] = true
    } else {
      simple[key] = value
    }
  }
  const printed = new Set(attributes)
  const add = (attribute) => {
    /** One attribute once: `focused` and `focusable` can both map to `focusable`, and a repeated word reads as a bug. */
    if (printed.has(attribute)) return
    printed.add(attribute)
    attributes.push(attribute)
  }
  for (const key of Object.keys(props).sort()) {
    if (EXCLUDED_ATTRIBUTES.has(key)) continue
    const mapped = BOOLEAN_ATTRIBUTE_NAMES[key]
    if (mapped !== undefined && simple[mapped] && !(isOption && mapped === 'selectable')) add(mapped)
    const value = simple[key]
    if (isOption && key === 'value' && value === node.name) continue
    if (value === true) add(key)
    else if (typeof value === 'string' || typeof value === 'number') add(`${key}="${value}"`)
  }
  return attributes
}

/** The tree as plain data, for a caller that wants to walk it rather than read it. */
export function snapshotToJson(node) {
  const result = { uid: node.uid }
  if (node.role !== undefined && node.role.length > 0) result.role = node.role
  if (node.name !== undefined && node.name.length > 0) result.name = node.name
  if (node.props !== undefined && Object.keys(node.props).length > 0) result.attributes = node.props
  const children = (node.children ?? []).map(snapshotToJson)
  if (children.length > 0) result.children = children
  return result
}

export { Page }
