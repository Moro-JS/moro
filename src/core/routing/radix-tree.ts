// High-performance Radix Tree for dynamic route matching

export interface RadixNode {
  // Store hash for faster lookups
  segmentHash: number;
  segment: string;
  staticChildren: Map<number, RadixNode> | null; // Hash-based lookup
  paramChild: RadixNode | null;
  paramName: string | null;
  handler: any;
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
    };
  }

  /**
   * Insert a route into the radix tree - HASH-BASED
   */
  insert(path: string, handler: any): void {
    let node = this.root;
    let i = 0;
    const len = path.length;

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

        // Create param child if needed
        if (!node.paramChild) {
          node.paramChild = {
            segmentHash: 0,
            segment: '',
            staticChildren: null,
            paramChild: null,
            paramName: path.slice(i + 1, end),
            handler: null,
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
        const child = {
          segmentHash,
          segment,
          staticChildren: null,
          paramChild: null,
          paramName: null,
          handler: null,
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
          };
          node.staticChildren.set(segmentHash, child);
        } else {
          // Verify segment matches (hash collision check)
          if (child.segment !== segment) {
            // Hash collision - fall back to slower string comparison
            // This is rare but we need to handle it
            continue; // Skip this route for now (simplified handling)
          }
        }
        node = child;
      }

      i = segEnd;
    }

    // Store handler
    node.handler = handler;
  }

  /**
   * Search for a route in the radix tree - HASH-BASED
   */
  search(path: string): MatchResult | null {
    const params: Record<string, string> = {};
    const result = this.searchNode(this.root, path, 0, params);

    if (result) {
      return { handler: result, params };
    }

    return null;
  }

  private searchNode(
    node: RadixNode,
    path: string,
    idx: number,
    params: Record<string, string>
  ): any {
    const len = path.length;

    // Skip slashes
    while (idx < len && path.charCodeAt(idx) === 47) {
      idx++;
    }

    // End of path - return handler if exists
    if (idx === len) {
      return node.handler;
    }

    // Try static children first (fastest) - hash-based lookup
    if (node.staticChildren) {
      // Extract current segment and compute hash (until next '/' or end)
      let segEnd = idx;
      const slashCode = 47; // '/'
      while (segEnd < len && path.charCodeAt(segEnd) !== slashCode) {
        segEnd++;
      }
      const segment = path.slice(idx, segEnd);
      const segmentHash = fastHash(segment);

      // Direct hash lookup (O(1))
      const child = node.staticChildren.get(segmentHash);
      if (child && child.segment === segment) {
        const result = this.searchNode(child, path, segEnd, params);
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
        const paramName = node.paramChild.paramName;
        if (paramName) {
          params[paramName] = path.slice(idx, end);
        }

        const result = this.searchNode(node.paramChild, path, end, params);
        if (result) {
          return result;
        }

        // Backtrack if no match
        if (paramName) {
          delete params[paramName];
        }
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
