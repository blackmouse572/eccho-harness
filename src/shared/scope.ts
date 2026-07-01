// Deterministic scope assessment: decide how big a PR is and which specialist
// reviewers it warrants. The master agent uses this to gate the fan-out so a
// one-line change doesn't spin up four subagents (and a container).

export type ChangedFile = {
	filename: string;
	additions: number;
	deletions: number;
	status?: string;
};

export type ReviewDimension = 'architecture' | 'testing' | 'security' | 'domain';
export type ChangeSize = 'tiny' | 'small' | 'medium' | 'large';

export type ScopeAssessment = {
	size: ChangeSize;
	totalChanges: number;
	fileCount: number;
	dimensions: ReviewDimension[];
	rationale: string;
};

const TEST_RE = /(\.test\.|\.spec\.|__tests__\/|\/tests?\/|\.e2e\.)/i;
const DOC_RE = /(\.mdx?$|\.txt$|(^|\/)docs\/)/i;
const CONFIG_RE = /(package\.json$|\.ya?ml$|\.toml$|\.lock$|lock\.json$|\.config\.|(^|\/)\.[^/]+$)/i;
const ADR_RE = /(\/adr\/|(^|\/)CONTEXT\.md$|\.github\/instructions\/)/i;
const SECURITY_RE =
	/(auth|login|password|secret|token|crypto|jwt|session|permission|role|guard|middleware|cors|sql|query|sanitiz|escap|webhook|payment|billing|upload|deserial|\bexec\b|\beval\b|env)/i;

function classify(file: ChangedFile) {
	const f = file.filename;
	const isDoc = DOC_RE.test(f);
	const isTest = TEST_RE.test(f);
	const isConfig = !isDoc && CONFIG_RE.test(f);
	const isSource = !isDoc && !isConfig; // ts/tsx/js/py/etc.
	return { isDoc, isTest, isConfig, isSource };
}

/** Whether a path is source code (not docs or config). */
export function isSourceFile(filename: string): boolean {
	return !DOC_RE.test(filename) && !CONFIG_RE.test(filename);
}

/**
 * Select the files one specialist actually needs (#4 — scope the diff per
 * reviewer instead of feeding every reviewer the whole PR). Returns an empty
 * array only when nothing matches; callers fall back to the full set.
 */
export function filesForDimension<T extends { filename: string }>(dim: ReviewDimension, files: T[]): T[] {
	switch (dim) {
		case 'architecture':
			return files.filter((f) => isSourceFile(f.filename));
		case 'testing':
			return files.filter((f) => isSourceFile(f.filename) || TEST_RE.test(f.filename));
		case 'security': {
			const sensitive = files.filter((f) => SECURITY_RE.test(f.filename));
			return sensitive.length ? sensitive : files.filter((f) => isSourceFile(f.filename));
		}
		case 'domain':
			return files.filter((f) => isSourceFile(f.filename) && !TEST_RE.test(f.filename));
	}
}

/** Assess a PR's change set and recommend which specialist reviewers to run. */
export function assessScope(files: ChangedFile[]): ScopeAssessment {
	const totalChanges = files.reduce((n, f) => n + f.additions + f.deletions, 0);
	const fileCount = files.length;

	let anySource = false;
	let anyTest = false;
	let anyDoc = false;
	let anyAdr = false;
	let anySensitive = false;
	for (const file of files) {
		const c = classify(file);
		anySource ||= c.isSource;
		anyTest ||= c.isTest;
		anyDoc ||= c.isDoc;
		anyAdr ||= ADR_RE.test(file.filename);
		anySensitive ||= SECURITY_RE.test(file.filename);
	}

	const size: ChangeSize =
		totalChanges < 100 ? 'tiny' : totalChanges < 300 ? 'small' : totalChanges < 600 ? 'medium' : 'large';

	const dimensions: ReviewDimension[] = [];
	const reasons: string[] = [];

	if (anySource && size !== 'tiny') {
		dimensions.push('architecture');
		reasons.push('source changed beyond trivial size');
	}
	if (anySource && size !== 'tiny' && size !== 'small') {
		dimensions.push('testing');
		reasons.push(anyTest ? 'tests touched' : 'source changed at medium+ scale');
	}
	if (anySensitive || size === 'large' || (anySource && totalChanges >= 300)) {
		dimensions.push('security');
		reasons.push(anySensitive ? 'security-sensitive paths touched' : 'large source change');
	}
	if (anyAdr) {
		dimensions.push('domain');
		reasons.push('ADR/CONTEXT touched');
	}

	if (dimensions.length === 0) {
		reasons.push(anyDoc ? 'docs/config-only change' : 'trivial change — master reviews directly');
	}

	return {
		size,
		totalChanges,
		fileCount,
		dimensions,
		rationale: reasons.join('; '),
	};
}
