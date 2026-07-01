import { test, expect } from 'bun:test';
import { assessScope, filesForDimension } from './scope.ts';

test('docs-only change recommends no specialists', () => {
	const s = assessScope([{ filename: 'README.md', additions: 5, deletions: 1, status: 'modified' }]);
	expect(s.size).toBe('tiny');
	expect(s.dimensions).toEqual([]);
});

test('tiny source change (<100 lines) gets no specialists', () => {
	const s = assessScope([{ filename: 'src/foo.ts', additions: 60, deletions: 10, status: 'modified' }]);
	expect(s.size).toBe('tiny');
	expect(s.dimensions).toEqual([]);
});

test('source change of exactly 100 lines is classified small with architecture', () => {
	const s = assessScope([{ filename: 'src/foo.ts', additions: 60, deletions: 40, status: 'modified' }]);
	expect(s.size).toBe('small');
	expect(s.dimensions).toContain('architecture');
	expect(s.dimensions).not.toContain('security');
});

test('a security-sensitive path pulls in security even when tiny', () => {
	const s = assessScope([{ filename: 'src/auth/login.ts', additions: 12, deletions: 0, status: 'modified' }]);
	expect(s.size).toBe('tiny');
	expect(s.dimensions).toContain('security');
});

test('an ADR change pulls in domain', () => {
	const s = assessScope([{ filename: 'docs/adr/0001-handoff.md', additions: 10, deletions: 0, status: 'added' }]);
	expect(s.dimensions).toContain('domain');
});

test('a large source change pulls in all four dimensions', () => {
	const s = assessScope([{ filename: 'src/big.ts', additions: 500, deletions: 200, status: 'modified' }]);
	expect(s.size).toBe('large');
	expect(new Set(s.dimensions)).toEqual(new Set(['architecture', 'testing', 'security', 'domain']));
});

test('filesForDimension scopes each reviewer to its relevant files', () => {
	const files = [
		{ filename: 'src/auth/login.ts' },
		{ filename: 'src/foo.test.ts' },
		{ filename: 'src/foo.ts' },
		{ filename: 'README.md' },
		{ filename: 'package.json' },
	];
	const names = (d: Parameters<typeof filesForDimension>[0]) => filesForDimension(d, files).map((f) => f.filename);
	expect(names('security')).toEqual(['src/auth/login.ts']);
	expect(names('domain')).toEqual(['src/auth/login.ts', 'src/foo.ts']);
	expect(names('architecture')).toEqual(['src/auth/login.ts', 'src/foo.test.ts', 'src/foo.ts']);
});
