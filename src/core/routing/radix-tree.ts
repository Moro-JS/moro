// High-performance Radix Tree for dynamic route matching

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

export class RadixTree {
  private root: RadixNode;

  constructor() {
    this.root = {
      segmentHash: 0,
      segment: '',
      staticChildren: null,
      paramChild: null,
      paramName: null,
      handler: null,
      paramPath: null,
      collisionNext: null,
    };
  }

  /**
   * Insert a route into the radix tree - HASH-BASED
   */
  insert(path: string, handler: any): void {
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
          node.paramChild = {
            segmentHash: 0,
            segment: '',
            staticChildren: null,
            paramChild: null,
            paramName: paramName,
            handler: null,
            paramPath: null,
            collisionNext: null,
          };
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
        const child: RadixNode = {
          segmentHash,
          segment,
          staticChildren: null,
          paramChild: null,
          paramName: null,
          handler: null,
          paramPath: null,
          collisionNext: null,
        };
        node.staticChildren.set(segmentHash, child);
        node = child;
      } else {
        let child = node.staticChildren.get(segmentHash);
        if (!child) {
          child = {
            segmentHash,
            segment,
            staticChildren: null,
            paramChild: null,
            paramName: null,
            handler: null,
            paramPath: null,
            collisionNext: null,
          };
          node.staticChildren.set(segmentHash, child);
        } else {
          // FNV hash collision: walk the sibling chain for a true segment match,
          // appending a new node if this exact segment isn't chained yet
          while (child.segment !== segment) {
            if (!child.collisionNext) {
              child.collisionNext = {
                segmentHash,
                segment,
                staticChildren: null,
                paramChild: null,
                paramName: null,
                handler: null,
                paramPath: null,
                collisionNext: null,
              };
            }
            child = child.collisionNext;
          }
        }
        node = child;
      }

      i = segEnd;
    }

    // Store handler and parameter names for this specific route
    node.handler = handler;
    node.paramPath = paramNames.length > 0 ? paramNames : null;
  }

  /**
   * Search for a route in the radix tree - HASH-BASED
   */
  search(path: string): MatchResult | null {
    const paramValues: string[] = [];
    const result = this.searchNode(this.root, path, 0, paramValues);

    if (result) {
      // Build params object using stored parameter names from the matched route
      const params: Record<string, string> = {};
      if (result.paramPath) {
        for (let i = 0; i < result.paramPath.length; i++) {
          params[result.paramPath[i] as string] = paramValues[i] as string;
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

    // Skip slashes
    while (idx < len && path.charCodeAt(idx) === 47) {
      idx++;
    }

    // End of path - return node if it has a handler
    if (idx === len) {
      return node.handler ? node : null;
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

  /**
   * Clear the tree
   */
  clear(): void {
    this.root = {
      segmentHash: 0,
      segment: '',
      staticChildren: null,
      paramChild: null,
      paramName: null,
      handler: null,
      paramPath: null,
      collisionNext: null,
    };
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
  addRoute(method: string, path: string, handler: any): void {
    let tree = this.trees.get(method);
    if (!tree) {
      tree = new RadixTree();
      this.trees.set(method, tree);
    }
    tree.insert(path, handler);
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
