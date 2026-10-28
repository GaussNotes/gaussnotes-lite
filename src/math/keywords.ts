import { cmd, type MNode, sym } from './model';

// Typed shortcuts, ported from the original GaussNotes keyword table (names,
// aliases and auto-aliases all included). With instant keywords on, a keyword
// converts as soon as it's typed, unless a longer keyword starts with it, in
// which case it waits for the next character. Otherwise keywords convert on
// space/Tab.

/** What a keyword inserts, and where the cursor goes: into the first empty slot by default. */
export interface KW {
  nodes: MNode[];
  /** 'after': cursor after the nodes. [node, slot, offset]: a specific spot. */
  at?: 'after' | [number, number, number];
}
type Make = () => KW;
const K = new Map<string, Make>();

const def = (names: string, make: () => MNode | MNode[] | KW) =>
  names.split(' ').forEach((n) =>
    K.set(n, () => {
      const r = make();
      return Array.isArray(r) ? { nodes: r } : 'nodes' in r ? r : { nodes: [r] };
    }),
  );
const s = (tex: string) => () => sym(tex);
const op = (tex: string) => (): KW => ({ nodes: [cmd('operatorname', 1, { slots: [[...tex].map(sym)] })], at: 'after' });
const delim = (open: string, close: string) => () => cmd('delim', 1, { open, close });
const wrap = (name: string) => () => cmd(name);
const filled = (name: string, tex: string): Make => () => ({ nodes: [cmd(name, 1, { slots: [[sym(tex)]] })], at: 'after' });
const limits = (tex: string, sup = true) => () => (sup ? [sym(tex), cmd('sub'), cmd('sup')] : [sym(tex), cmd('sub')]);
const derivative = (d: string) => (): KW => ({
  nodes: [cmd('frac', 2, { slots: [[sym(d)], [sym(d)]] })],
  at: [0, 0, 1], // after the d in the numerator
});

// Greek. The original used doubled spellings (pii, xii, psii) to dodge prefix clashes; both work here.
for (const g of 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega varepsilon vartheta varpi varrho varsigma varphi'.split(' '))
  def(g, s('\\' + g));
def('xii', s('\\xi'));
def('pii', s('\\pi'));
def('psii', s('\\psi'));
def('vepsilon eps', s('\\varepsilon'));
def('vtheta', s('\\vartheta'));
def('vpii vpi', s('\\varpi'));
def('vrho', s('\\varrho'));
def('vsigma', s('\\varsigma'));
def('vphi', s('\\varphi'));
def('laplacian lap', s('\\Delta'));

// Logic, sets, relations.
def('nEE nexists', s('\\nexists'));
def('EE exists', s('\\exists'));
def('AA forall', s('\\forall'));
def('grad nabla', s('\\nabla'));
def('del partial', s('\\partial'));
def('inn in', s('\\in'));
def('ninn notin', s('\\notin'));
def('ni', s('\\ni'));
def('notni', s('\\notni'));
def('subs subset', s('\\subset'));
def('sub= subseteq subeq subset=', s('\\subseteq'));
def('sups supset', s('\\supset'));
def('sups= supseteq supeq supset=', s('\\supseteq'));
def('nsubseteq', s('\\nsubseteq'));
def('nsupseteq', s('\\nsupseteq'));
def('empty emptyset varnothing', s('\\varnothing'));
def('cup union', s('\\cup'));
def('cap intersection', s('\\cap'));
def('u++ unionplus uplus', s('\\uplus'));
def('sqcup', s('\\sqcup'));
def('and wedge', s('\\wedge'));
def('orr or vee', s('\\vee'));
def('larr leftarrow larrow gets', s('\\leftarrow'));
def('rarr rightarrow rarrow too to', s('\\to'));
def('neq not=', s('\\neq'));
def('approx', s('\\approx'));
def('~= cong', s('\\cong'));
def('-= equiv', s('\\equiv'));
def('propto', s('\\propto'));
def('sim', s('\\sim'));
def('iff ifandonlyif lrarr lrarrow leftrightarrow', s('\\iff'));
def('geq', s('\\geq'));
def('leq', s('\\leq'));
def('gg', s('\\gg'));
def('ll', s('\\ll'));
def('implies', s('\\Rightarrow'));
def('impliedby', s('\\Leftarrow'));
def('mapsto', s('\\mapsto'));
def('follow leadsto', s('\\leadsto'));
def('perp', s('\\perp'));
def('TT top', s('\\top'));
def('parallel', s('\\parallel'));

// Operators and constants.
def('oo infinity infty', s('\\infty'));
def('aleph', s('\\aleph'));
def('xx times', s('\\times'));
def('cdot', s('\\cdot'));
def('cdots', s('\\cdots'));
def('vdots', s('\\vdots'));
def('ddots', s('\\ddots'));
def('circ', s('\\circ'));
def('ast', s('\\ast'));
def('star', s('\\star'));
def('o++ oplus', s('\\oplus'));
def('o.. odot', s('\\odot'));
def('oxx otimes', s('\\otimes'));
def('+- pm', s('\\pm'));
def('-+ mp', s('\\mp'));
def('dag dagger', s('\\dagger'));
def('hbar', s('\\hbar'));
def('ell', s('\\ell'));
def('jhat', s('\\hat{\\jmath}'));
def('ihat', s('\\hat{\\imath}'));
def('NN natural', s('\\mathbb{N}'));
def('ZZ integer', s('\\mathbb{Z}'));
def('QQ rational', s('\\mathbb{Q}'));
def('RR real', s('\\mathbb{R}'));
def('CC complex', s('\\mathbb{C}'));
def('HH quaternion', s('\\mathbb{H}'));
def('FF', s('\\mathbb{F}'));
def('PP', s('\\mathbb{P}'));
def('Exp expectation', s('\\mathbb{E}'));

// Functions.
for (const f of 'ln exp sin cos tan cot sec csc sinh cosh tanh coth det dim ker gcd arg deg inf max min'.split(' ')) def(f, s('\\' + f));
def('asin arcsin', s('\\arcsin'));
def('acos arccos', s('\\arccos'));
def('atan arctan', s('\\arctan'));
def('supp sup', s('\\sup'));
def('tr trace', op('tr'));
for (const f of 'rank sgn span lcm mod im Im Re'.split(' ')) def(f, op(f));
def('card cardinal', op('card'));
def('log', limits('\\log', false));
def('lim', limits('\\lim', false));
def('limsup', limits('\\limsup', false));
def('liminf', limits('\\liminf', false));

// Big operators come with empty limit slots to fill.
for (const [names, tex] of [
  ['sum', 'sum'], ['prod', 'prod'], ['coprod', 'coprod'], ['int', 'int'], ['iint', 'iint'], ['iiint', 'iiint'],
  ['oint', 'oint'], ['oiint', 'oiint'], ['oiiint', 'oiiint'], ['Cup bigcup', 'bigcup'], ['Cap bigcap', 'bigcap'],
  ['U++ biguplus', 'biguplus'], ['Vee bigvee', 'bigvee'], ['And bigwedge', 'bigwedge'], ['Sqcup bigsqcup', 'bigsqcup'],
  ['O++ bigoplus', 'bigoplus'], ['Oxx Ox bigotimes', 'bigotimes'], ['O.. bigodot', 'bigodot'],
] as const)
  def(names, limits('\\' + tex));

// Structures.
def('td tt tothe power pow', wrap('sup'));
def('subscript', wrap('sub'));
K.set('sr', filled('sup', '2'));
K.set('cb', filled('sup', '3'));
def('frac', () => cmd('frac', 2));
def('binom choose nCr', () => cmd('binom', 2));
def('sqrt', wrap('sqrt'));
def('rt root', () => cmd('root', 2));
def('tend', () => cmd('xrightarrow', 2));
K.set('ddx', derivative('d'));
K.set('ddel', derivative('\\partial'));
def('hat', wrap('widehat'));
def('bar', wrap('bar'));
def('vec', wrap('overrightarrow'));
def('dot', wrap('dot'));
def('ddot', wrap('ddot'));
def('tilde', wrap('widetilde'));
def('overline', wrap('overline'));
def('underline', wrap('underline'));
def('overbrace', () => [cmd('overbrace'), cmd('sup')]);
def('underbrace', () => [cmd('underbrace'), cmd('sub')]);
def('bf bold', wrap('mathbf'));
def('fk frak', wrap('mathfrak'));
def('rm roman', wrap('mathrm'));
def('txt text', wrap('text'));
def('bb blackboard', wrap('mathbb'));
def('cal calligraphy', wrap('mathcal'));
for (const c of ['red', 'blue', 'green', 'yellow']) def(c, () => cmd('textcolor', 1, { env: c }));
def('abs lvert', delim('|', '|'));
def('bracket lbracket', delim('[', ']'));
def('norm lVert llvert', delim('\\|', '\\|'));
def('bra', delim('\\langle', '|'));
def('ket', delim('|', '\\rangle'));
def('ang angle langle', delim('\\langle', '\\rangle'));
def('flr floor', delim('\\lfloor', '\\rfloor'));
def('ciel ceil', delim('\\lceil', '\\rceil'));
def('quad', s('\\quad'));
def('qquad', s('\\qquad'));

const MATRIX = /^(p|b|v|B|V)?(mat|sys)(\d)(?:x(\d))?$/;

// Too often ordinary letters (x in A, f to g…) to convert without space/Tab.
const NO_AUTO = new Set(['in', 'to', 'or', 'ni', 'notni', 'im', 'ell']);
// Convert at once even though longer keywords start with them: the longer ones are mostly
// spelled-out aliases (int → integer, tr → trace). \limsup etc. remain typeable with a backslash.
const EAGER = new Set(['lim', 'int', 'exp', 'card', 'tr', 'pow', 'union', 'cal', 'dag', 'empty', 'larr', 'rarr', 'lrarr', 'ang', 'Ox', 'lap']);
const MATRIX_PREFIX = /^[pbvBV]?(m|ma|mat|s|sy|sys)$/;

const waits = (name: string) => {
  if (EAGER.has(name)) return false;
  for (const k of K.keys()) if (k !== name && k.startsWith(name)) return true;
  return false;
};

/** Keyword for `name` if it should convert as soon as it's typed. */
export function autoKeyword(name: string): KW | null {
  if (name.length < 2 || NO_AUTO.has(name) || MATRIX_PREFIX.test(name) || waits(name)) return null;
  return keyword(name);
}

/** A keyword that was waiting (sin, del…) and can no longer grow once `next` is typed after it. */
export function settledKeyword(word: string, next: string): boolean {
  if (word.length < 2 || NO_AUTO.has(word) || !K.has(word) || MATRIX_PREFIX.test(word)) return false;
  return !isKeywordPrefix(word + next);
}

/** True if some keyword starts with `prefix` (so what's being typed may still become it). */
export const isKeywordPrefix = (prefix: string) => [...K.keys()].some((k) => k.startsWith(prefix));

/** Length of the longest suffix of `word` that some keyword starts with: the word still being typed. */
export function growingSuffix(word: string): number {
  for (let len = word.length; len > 0; len--) if (isKeywordPrefix(word.slice(word.length - len))) return len;
  return 0;
}

/** Keywords containing symbols (u++, sub=, not=…) convert the moment they're complete. */
export function symbolKeyword(name: string): KW | null {
  return /[^a-zA-Z]/.test(name) && K.has(name) ? keyword(name) : null;
}

export function keyword(name: string): KW | null {
  const make = K.get(name);
  if (make) return make();
  const m = MATRIX.exec(name);
  if (m) {
    const rows = +m[3];
    const cols = m[4] ? +m[4] : m[2] === 'sys' ? 2 : rows;
    const env = m[2] === 'sys' ? 'cases' : (m[1] ?? '') + 'matrix';
    if (rows < 1 || cols < 1) return null;
    return { nodes: [cmd('matrix', rows * cols, { env, cols })] };
  }
  return null;
}

/** Symbol sequences that convert immediately, longest first (always on, like the original's +-, <=, =>). */
export const AUTO: [string[], string][] = [
  [['.', '.', '.'], '\\ldots'],
  [['\\leq', '>'], '\\iff'], // <=>
  [['<', '='], '\\leq'],
  [['>', '='], '\\geq'],
  [['!', '='], '\\neq'],
  [['-', '>'], '\\to'],
  [['=', '>'], '\\Rightarrow'],
  [['+', '-'], '\\pm'],
  [['-', '+'], '\\mp'],
  [['\\sim', '\\sim'], '\\approx'],
  [['\\sim', '='], '\\cong'],
  [['<', '<'], '\\ll'],
  [['>', '>'], '\\gg'],
];

export const keywordNames = () => [...K.keys()];
