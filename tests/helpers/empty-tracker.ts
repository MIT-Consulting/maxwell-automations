/** Empty but valid five-column phase tracker for kickoff-ready fixtures. */
export function emptyFeatureIndex(title: string): string {
  return `# ${title}

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
`;
}
