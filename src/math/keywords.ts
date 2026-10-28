import { cmd, type MNode, sym } from './model';

// Typed shortcuts, in the spirit of the original GaussNotes keyword table.
// Word keywords convert on space (or when a non-letter is typed after them);
// symbol sequences in AUTO convert as soon as they are typed.

type Make = () => MNode;
const K = new Map<string, Make>();
const def = (names: string, make: Make) => names.split(' ').forEach((n) => K.set(n, make));
const s = (tex: string) => () => sym(tex);
const delim = (open: string, close: string) => () => cmd('delim', 1, { open, close });

const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega';
GREEK.split(' ').forEach((g) => def(g, s('\\' + g)));
def('eps', s('\\varepsilon'));

const PLAIN = 'sum prod coprod int iint iiint oint lim limsup liminf max min sup inf det gcd sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh log ln exp dim ker deg arg hom Pr cdot cdots ldots vdots ddots times div pm mp circ ast star oplus otimes odot wedge vee cup cap setminus subset subseteq supset supseteq in notin ni emptyset varnothing forall exists nexists neg leq geq neq approx equiv sim simeq cong propto perp parallel mid to mapsto implies iff Rightarrow Leftarrow Leftrightarrow leftarrow rightarrow leftrightarrow uparrow downarrow ll gg nabla partial hbar ell Re Im aleph angle prime infty dagger bullet top bot vdash models langle rangle quad qquad';
PLAIN.split(' ').forEach((n) => def(n, s('\\' + n)));

def('oo infinity', s('\\infty'));
def('xx', s('\\times'));
def('del', s('\\partial'));
def('grad', s('\\nabla'));
def('inn', s('\\in'));
def('ninn', s('\\notin'));
def('subs', s('\\subset'));
def('empty', s('\\varnothing'));
def('AA', s('\\forall'));
def('EE', s('\\exists'));
def('and', s('\\wedge'));
def('orr', s('\\vee'));
def('larr gets', s('\\leftarrow'));
def('rarr', s('\\rightarrow'));
def('lap', s('\\Delta'));
for (const L of 'N Z Q R C H F P E'.split(' ')) def(L + L, s(`\\mathbb{${L}}`));

def('frac', () => cmd('frac', 2));
def('binom choose', () => cmd('binom', 2));
def('sqrt', () => cmd('sqrt'));
def('root', () => cmd('root', 2));
def('text', () => cmd('text'));
for (const a of 'hat bar vec dot ddot tilde widehat overline underline mathbf mathcal mathbb mathrm mathfrak boldsymbol boxed operatorname'.split(' ')) def(a, () => cmd(a));
def('bf', () => cmd('mathbf'));
def('cal', () => cmd('mathcal'));
def('bb', () => cmd('mathbb'));
def('overset', () => cmd('overset', 2));
def('underset', () => cmd('underset', 2));
def('abs', delim('|', '|'));
def('norm', delim('\\|', '\\|'));
def('ang', delim('\\langle', '\\rangle'));
def('bra', delim('\\langle', '|'));
def('ket', delim('|', '\\rangle'));
def('ceil', delim('\\lceil', '\\rceil'));
def('floor', delim('\\lfloor', '\\rfloor'));

const MATRIX = /^(p|b|v|B|V)?(mat|sys)(\d)(?:x(\d))?$/;

export function keyword(name: string): MNode | null {
  const make = K.get(name);
  if (make) return make();
  const m = MATRIX.exec(name);
  if (m) {
    const rows = +m[3];
    const cols = m[4] ? +m[4] : m[2] === 'sys' ? 2 : rows;
    const env = m[2] === 'sys' ? 'cases' : (m[1] ?? '') + 'matrix';
    if (rows < 1 || cols < 1) return null;
    return cmd('matrix', rows * cols, { env, cols });
  }
  return null;
}

/** Symbol sequences that convert immediately, longest first. */
export const AUTO: [string[], string][] = [
  [['.', '.', '.'], '\\ldots'],
  [['<', '='], '\\leq'],
  [['>', '='], '\\geq'],
  [['!', '='], '\\neq'],
  [['-', '>'], '\\to'],
  [['=', '>'], '\\Rightarrow'],
  [['+', '-'], '\\pm'],
  [['-', '+'], '\\mp'],
  [['\\sim', '\\sim'], '\\approx'],
  [['<', '<'], '\\ll'],
  [['>', '>'], '\\gg'],
];

export const keywordNames = () => [...K.keys()];
