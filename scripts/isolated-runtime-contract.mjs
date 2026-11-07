/** Compare identities, not just counts: a duplicate can hide a missing tool. */
export function toolContractError(tools, expectedNames) {
  if (!Array.isArray(tools) || tools.some(tool => typeof tool?.name !== 'string')) {
    return 'Malformed tools/list response';
  }
  const names = tools.map(tool => tool.name).sort();
  const expected = [...expectedNames].sort();
  if (new Set(names).size !== names.length) return 'Duplicate tool names';
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    return `Tool identity mismatch: expected ${expected.join(', ')}, got ${names.join(', ')}`;
  }
  return null;
}
