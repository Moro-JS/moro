// High-performance Radix Tree for dynamic route matching
import { decodeParam } from './decode-param.js';

export interface RadixNode {
  // Store hash for faster lookups
  segmentHash: number;
  segment: string;
  staticChildren: Map<number, RadixNode> | null; // Hash-based lookup
  paramChild: RadixNode | null;
  paramName: string | null;
  handler: any;
  // Store parameter names for this specific handler/route
  paramPath: string[] | null;
  // Sibling chain for FNV hash collisions (segments with equal hash, different text)
  collisionNext: RadixNode | null;
  // The route that takes the rest of the path below this node ('/files/*'),
  // tried after everything else here; its paramPath ends with the wildcard's
  // name.
  wildcardChild: RadixNode | null;
}

/** How a path is inserted; see RadixTree.insert. */
export interface RadixInsertOptions {
  /**
   * The path is one form of a route with optional parameters. A route whose
   * path is exactly this one keeps the node, whichever was inserted first.
   */
  optional?: boolean;
  /**
   * The route also takes the rest of the path below `path`: the name its
   * value has in the params ('*' unless the wildcard was given a name).
   */
  wildcard?: string;
}

export interface MatchResult {
  handler: any;
  params: Record<string, string>;
}

// Fast hash function for path segments (FNV-1a inspired)
function fastHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  const len = str.length;

  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime (32-bit)
  }

  return hash;
}

// Same hash computed over a path slice without allocating the substring
function fastHashRange(path: string, start: number, end: number): number {
  let hash = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    hash ^= path.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// Compare a stored segment against a path slice without allocating
function segmentEqualsRange(segment: string, path: string, start: number, end: number): boolean {
  if (segment.length !== end - start) return false;
  for (let i = start; i < end; i++) {
    if (segment.charCodeAt(i - start) !== path.charCodeAt(i)) return false;
  }
  return true;
}

// Every node has the same fields in the same order, so the lookup reads one
// object shape whatever the routes are
function createNode(segmentHash: number, segment: string, paramName: string | null): RadixNode {
  return {
    segmentHash,
    segment,
    staticChildren: null,
    paramChild: null,
    paramName,
    handler: null,
    paramPath: null,
    collisionNext: null,
    wildcardChild: null,
  };
}

export class RadixTree {
  private root: RadixNode;
  // Scratch buffer for search() - see the comment there before touching
  private readonly paramScratch: string[] = [];
  // The nodes whose handler is a route with optional parameters
  private optionalForms = new Set<RadixNode>();
  // Whether any route in the tree ends in a wildcard
  private hasWildcards = false;

  constructor() {
    this.root = createNode(0, '', null);
  }

  /**
   * Insert a route into the radix tree - HASH-BASED
   *
   * `path` is fixed text and required parameters. A route with optional
   * parameters is inserted once for each path it stands for, with
   * `optional` set; a route that ends in a wildcard is inserted at the path
   * in front of the wildcard, with `wildcard` set to the wildcard's name.
   *
   * What the lookup prefers does not depend on the order of insertion: fixed
   * text before a parameter, a route whose path is exactly the one asked for
   * before a route with optional parameters, and a wildcard last, the one
   * with the longest path in front of it first.
   */
  insert(path: string, handler: any, options?: RadixInsertOptions): void {
    let node = this.root;
    let i = 0;
    const len = path.length;
    const paramNames: string[] = [];

    // Skip leading slash
    if (len > 0 && path.charCodeAt(0) === 47) {
      i = 1;
    }

    while (i < len) {
      const charCode = path.charCodeAt(i);

      // Skip any additional slashes
      if (charCode === 47) {
        i++;
        continue;
      }

      // Check for parameter (58 = ':')
      if (charCode === 58) {
        // Find end of parameter name (47 = '/')
        let end = i + 1;
        while (end < len && path.charCodeAt(end) !== 47) {
          end++;
        }

        const paramName = path.slice(i + 1, end);
        paramNames.push(paramName);

        // Create param child if needed
        if (!node.paramChild) {
          node.paramChild = createNode(0, '', paramName);
        }

        node = node.paramChild;
        i = end;
        continue;
      }

      // Find end of static segment (up to next '/' or ':')
      let segEnd = i + 1;
      while (segEnd < len) {
        const code = path.charCodeAt(segEnd);
        if (code === 47 || code === 58) break; // '/' or ':'
        segEnd++;
      }
      const segment = path.slice(i, segEnd);
      const segmentHash = fastHash(segment);

      // Lazy initialization of staticChildren (hash-based)
      if (!node.staticChildren) {
        node.staticChildren = new Map();
        const child: RadixNode = createNode(segmentHash, segment, null);
        node.staticChildren.set(segmentHash, child);
        node = child;
      } else {
        let child = node.staticChildren.get(segmentHash);
        if (!child) {
          child = createNode(segmentHash, segment, null);
          node.staticChildren.set(segmentHash, child);
        } else {
          // FNV hash collision: walk the sibling chain for a true segment match,
          // appending a new node if this exact segment isn't chained yet
          while (child.segment !== segment) {
            if (!child.collisionNext) {
              child.collisionNext = createNode(segmentHash, segment, null);
            }
            child = child.collisionNext;
          }
        }
        node = child;
      }

      i = segEnd;
    }

    if (options !== undefined && options.wildcard !== undefined) {
      // The rest of the path is one more value, after the parameters'
      paramNames.push(options.wildcard);
      const wildcard = createNode(0, '', null);
      wildcard.handler = handler;
      wildcard.paramPath = paramNames;
      node.wildcardChild = wildcard;
      this.hasWildcards = true;
      return;
    }

    if (options !== undefined && options.optional === true) {
      // A route registered for exactly this path keeps it
      if (node.handler && !this.optionalForms.has(node)) return;
      this.optionalForms.add(node);
    } else {
      this.optionalForms.delete(node);
    }

    // Store handler and parameter names for this specific route
    node.handler = handler;
    node.paramPath = paramNames.length > 0 ? paramNames : null;
  }

  /**
   * Search for a route in the radix tree - HASH-BASED
   */
  search(path: string): MatchResult | null {
    // Reused across calls: search is synchronous and the values are copied
    // into the fresh params object below before returning, so nothing escapes
    const paramValues = this.paramScratch;
    paramValues.length = 0;
    let result = this.searchNode(this.root, path, 0, paramValues);
    if (result === null && this.hasWildcards) {
      // A wildcard is tried once every other route has turned the path down
      paramValues.length = 0;
      result = this.searchWildcard(this.root, path, 0, paramValues);
    }

    if (result) {
      // Build params object using stored parameter names from the matched route
      const params: Record<string, string> = {};
      if (result.paramPath) {
        for (let i = 0; i < result.paramPath.length; i++) {
          params[result.paramPath[i] as string] = decodeParam(paramValues[i] as string);
        }
      }
      return { handler: result.handler, params };
    }

    return null;
  }

  private searchNode(
    node: RadixNode,
    path: string,
    idx: number,
    paramValues: string[]
  ): RadixNode | null {
    const len = path.length;

    // End of path - return node if it has a handler
    if (idx === len) {
      return node.handler ? node : null;
    }

    // Exactly one '/' starts every segment. A path with no leading slash or
    // with an empty segment ('//admin/users/1', '/admin//users/1') is not
    // matched: req.path keeps such a path as it was sent, so a route found
    // for it would be one that a prefix check in middleware never saw.
    if (path.charCodeAt(idx) !== 47) {
      return null;
    }
    idx++;

    // A single trailing slash still ends the path
    if (idx === len) {
      return node.handler ? node : null;
    }
    if (path.charCodeAt(idx) === 47) {
      return null;
    }

    // Try static children first (fastest) - hash-based lookup
    if (node.staticChildren) {
      // Extract current segment and compute hash (until next '/' or end)
      let segEnd = idx;
      const slashCode = 47; // '/'
      while (segEnd < len && path.charCodeAt(segEnd) !== slashCode) {
        segEnd++;
      }
      // Hash and compare in place - no substring allocation per segment
      const segmentHash = fastHashRange(path, idx, segEnd);

      // Direct hash lookup (O(1)), walking the collision chain if needed
      let child: RadixNode | null | undefined = node.staticChildren.get(segmentHash);
      while (child && !segmentEqualsRange(child.segment, path, idx, segEnd)) {
        child = child.collisionNext;
      }
      if (child) {
        const result = this.searchNode(child, path, segEnd, paramValues);
        if (result) {
          return result;
        }
      }
    }

    // Try parameter child
    if (node.paramChild) {
      // Find end of param value (next '/' or end of path)
      let end = idx;
      const slashCode = 47; // '/'
      while (end < len && path.charCodeAt(end) !== slashCode) {
        end++;
      }

      if (end > idx) {
        const paramValue = path.slice(idx, end);
        paramValues.push(paramValue);

        const result = this.searchNode(node.paramChild, path, end, paramValues);
        if (result) {
          return result;
        }

        // Backtrack if no match
        paramValues.pop();
      }
    }

    return null;
  }

  // The wildcard route for a path that no other route took. The same walk as
  // searchNode - fixed text before a parameter, deepest first - that ends at
  // a node with a wildcard instead of at the end of the path, so the wildcard
  // with the longest path in front of it is the one found. A wildcard takes
  // what follows the slash after its node: nothing ('/files/'), or segments
  // none of which is empty. An empty segment ('/files//x', '/files/a//b') is
  // not matched here either.
  private searchWildcard(
    node: RadixNode,
    path: string,
    idx: number,
    paramValues: string[]
  ): RadixNode | null {
    const len = path.length;
    if (idx === len || path.charCodeAt(idx) !== 47) return null;
    idx++;

    if (idx === len) {
      if (node.wildcardChild === null) return null;
      paramValues.push('');
      return node.wildcardChild;
    }
    if (path.charCodeAt(idx) === 47) return null;

    let segEnd = idx;
    while (segEnd < len && path.charCodeAt(segEnd) !== 47) segEnd++;

    if (node.staticChildren) {
      let child: RadixNode | null | undefined = node.staticChildren.get(
        fastHashRange(path, idx, segEnd)
      );
      while (child && !segmentEqualsRange(child.segment, path, idx, segEnd)) {
        child = child.collisionNext;
      }
      if (child) {
        const result = this.searchWildcard(child, path, segEnd, paramValues);
        if (result) return result;
      }
    }

    if (node.paramChild) {
      paramValues.push(path.slice(idx, segEnd));
      const result = this.searchWildcard(node.paramChild, path, segEnd, paramValues);
      if (result) return result;
      paramValues.pop();
    }

    if (node.wildcardChild !== null && path.indexOf('//', segEnd) === -1) {
      paramValues.push(path.slice(idx));
      return node.wildcardChild;
    }
    return null;
  }

  /**
   * Clear the tree
   */
  clear(): void {
    this.root = createNode(0, '', null);
    this.optionalForms.clear();
    this.hasWildcards = false;
  }
}

/**
 * Method-specific radix tree router
 */
export class MethodRadixRouter {
  private trees: Map<string, RadixTree>;

  constructor() {
    this.trees = new Map();
  }

  /**
   * Add a route - OPTIMIZED
   */
  addRoute(method: string, path: string, handler: any, options?: RadixInsertOptions): void {
    let tree = this.trees.get(method);
    if (!tree) {
      tree = new RadixTree();
      this.trees.set(method, tree);
    }
    tree.insert(path, handler, options);
  }

  /**
   * Find a route - OPTIMIZED
   */
  findRoute(method: string, path: string): MatchResult | null {
    const tree = this.trees.get(method);
    return tree ? tree.search(path) : null;
  }

  /**
   * Clear all routes
   */
  clear(): void {
    this.trees.clear();
  }
}
