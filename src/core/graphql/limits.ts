// Query depth and complexity limits, checked on the parsed document

/**
 * What one operation costs.
 *
 * - `depth` is the number of nested field levels: `{ a }` is 1, `{ a { b } }` is 2.
 * - `complexity` is the number of fields the operation selects. A fragment is
 *   counted every time it is spread.
 *
 * Introspection meta fields (`__typename`, `__schema`, `__type`) and what is
 * selected under them are not counted: introspection has its own switch.
 */
export interface QueryCost {
  depth: number;
  complexity: number;
}

export interface QueryLimits {
  maxDepth?: number | undefined;
  maxComplexity?: number | undefined;
}

/** A limit is a finite number of at least 1; anything else means "no limit". */
export function normalizeQueryLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/**
 * Measure a selection set. `getFragment` resolves a fragment name to its
 * definition; `fragmentCosts` remembers each fragment's cost so a document
 * that spreads the same fragment many times is still measured in one pass.
 */
export function measureSelectionSet(
  selectionSet: any,
  getFragment: (name: string) => any,
  fragmentCosts: Map<string, QueryCost | null> = new Map()
): QueryCost {
  let depth = 0;
  let complexity = 0;
  const selections: any[] = selectionSet?.selections || [];

  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const name: string = selection.name?.value || '';
      if (name.startsWith('__')) continue;
      const child = selection.selectionSet
        ? measureSelectionSet(selection.selectionSet, getFragment, fragmentCosts)
        : NO_COST;
      depth = Math.max(depth, 1 + child.depth);
      complexity += 1 + child.complexity;
    } else if (selection.kind === 'InlineFragment') {
      const child = measureSelectionSet(selection.selectionSet, getFragment, fragmentCosts);
      depth = Math.max(depth, child.depth);
      complexity += child.complexity;
    } else if (selection.kind === 'FragmentSpread') {
      const name: string = selection.name?.value || '';
      let cost = fragmentCosts.get(name);
      if (cost === undefined) {
        const fragment = getFragment(name);
        if (!fragment) continue; // unknown fragment: the standard rules report it
        // null marks a fragment that is being measured, so a fragment that
        // spreads itself (also reported by the standard rules) ends here
        fragmentCosts.set(name, null);
        cost = measureSelectionSet(fragment.selectionSet, getFragment, fragmentCosts);
        fragmentCosts.set(name, cost);
      }
      if (cost === null) continue;
      depth = Math.max(depth, cost.depth);
      complexity += cost.complexity;
    }
  }

  return { depth, complexity };
}

const NO_COST: QueryCost = { depth: 0, complexity: 0 };

/**
 * Check a parsed document against the limits, before the standard validation
 * rules and before execution. Returns one error per limit an operation is
 * over: nested deeper than `maxDepth`, or selecting more than `maxComplexity`
 * fields. With an `operationName` only that operation is measured, as only
 * that one would run; without it every operation in the document is.
 *
 * `GraphQLError` is the class of the graphql package the schema was built
 * with, so the errors are that package's own.
 */
export function checkQueryLimits(
  document: any,
  GraphQLError: new (message: string, options?: any) => any,
  limits: QueryLimits,
  operationName?: string | null
): any[] {
  const maxDepth = normalizeQueryLimit(limits.maxDepth);
  const maxComplexity = normalizeQueryLimit(limits.maxComplexity);
  const errors: any[] = [];
  if (maxDepth === undefined && maxComplexity === undefined) return errors;

  const definitions: any[] = document?.definitions || [];
  let fragments: Map<string, any> | undefined;
  const getFragment = (name: string) => {
    if (!fragments) {
      fragments = new Map();
      for (const definition of definitions) {
        if (definition.kind === 'FragmentDefinition') {
          fragments.set(definition.name.value, definition);
        }
      }
    }
    return fragments.get(name);
  };
  const fragmentCosts = new Map<string, QueryCost | null>();

  for (const node of definitions) {
    if (node.kind !== 'OperationDefinition') continue;
    if (operationName && node.name?.value !== operationName) continue;
    const cost = measureSelectionSet(node.selectionSet, getFragment, fragmentCosts);

    if (maxDepth !== undefined && cost.depth > maxDepth) {
      errors.push(
        new GraphQLError(
          `Query depth of ${cost.depth} exceeds maximum allowed depth of ${maxDepth}`,
          { nodes: [node], extensions: { code: 'QUERY_TOO_DEEP' } }
        )
      );
    }
    if (maxComplexity !== undefined && cost.complexity > maxComplexity) {
      errors.push(
        new GraphQLError(
          `Query complexity of ${cost.complexity} exceeds maximum allowed complexity of ${maxComplexity}`,
          { nodes: [node], extensions: { code: 'QUERY_TOO_COMPLEX' } }
        )
      );
    }
  }

  return errors;
}
