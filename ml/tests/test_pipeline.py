import ast
import subprocess
import sys
from pathlib import Path

import numpy as np

from elementml import config as C
from elementml import features as F
from elementml.data import Card, generate_cards, importance_of, load_fixture_cards
from elementml.features import CrowdLedger, CrowdTables, UserState, make_prior
from elementml.ranking import candidates as stage1
from elementml.ranking import diversity as rerank
from elementml.ranking.baselines import CurrentServer, RecencyImportance, diversify_feed
from elementml.serving import Ranker, Variant

ROOT = Path(__file__).resolve().parents[1] / "elementml"
# Every module a ranker is built from. evaluation/policies.py wires rankers for the evaluation and may name the
# Persona type under TYPE_CHECKING only.
RANKER_DIRS = ["data", "features", "ranking", "serving"]
RANKER_FILES = sorted(p for d in RANKER_DIRS for p in (ROOT / d).glob("*.py")) + \
    [ROOT / "interfaces.py", ROOT / "config.py", ROOT / "paths.py", ROOT / "embed.py", ROOT / "evaluation" / "policies.py"]
SIM_NAMES = {"sim", "simulator"}


def make_state(emb, cat, now, n_like=3, follows=("tech",)):
    s = UserState("u", emb.k, follows=list(follows), prior=make_prior(emb, list(follows)), now=now - 30)
    liked = [i for i, c in enumerate(cat.cards) if c.category == "tech" and c.sort_at < now - 5][:n_like]
    for i in liked:
        s.observe(cat.cards[i], cat.emb[i], [("view", None), ("like", None), ("dwell", 9000.0)], now - 10)
    return s


# ---- no leakage of simulator internals ---------------------------------------------------
def _type_checking_nodes(tree) -> set:
    """Every node inside an `if TYPE_CHECKING:` block."""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING":
            for child in node.body:
                out |= set(ast.walk(child))
    return out


def test_ranker_modules_never_import_the_simulator():
    assert len(RANKER_FILES) > 15                                   # the folders exist and were found
    for p in RANKER_FILES:
        tree = ast.parse(p.read_text(encoding="utf-8"))
        allowed = _type_checking_nodes(tree) if p.name == "policies.py" else set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert not any(SIM_NAMES & set(a.name.split(".")) for a in node.names), p
            if isinstance(node, ast.ImportFrom):
                parts = set((node.module or "").split(".")) | {a.name for a in node.names}
                if SIM_NAMES & parts:
                    assert node in allowed, f"{p.relative_to(ROOT)} imports the simulator"
    out = subprocess.run([sys.executable, "-I", "-c",
                          "import sys; sys.path.insert(0, r'%s'); import elementml.serving, elementml.evaluation.policies, "
                          "elementml.ranking.baselines, elementml.features, elementml.data;"
                          "print(any(m.startswith(('elementml.sim', 'elementml.simulator')) for m in sys.modules))" % ROOT.parent],
                         capture_output=True, text=True)
    assert out.stdout.strip() == "False", out.stderr


def test_card_record_and_features_have_no_hidden_fields():
    fields = set(Card.__dataclass_fields__)
    assert not {f for f in fields if "latent" in f or "taste" in f or "subtopic" in f or "true" in f}
    assert not [n for n in F.NAMES if any(w in n for w in ("latent", "taste", "true", "persona", "noise", "sub_main"))]
    from elementml.training import train
    assert set(train.WHITELIST) == {"like", "dislike", "detail", "dwell"}      # the logger never reads z or any hidden value


def test_train_and_eval_seeds_are_disjoint():
    from elementml.training.train import EVAL_PERSONA_BASE, EVAL_WORLD_BASE, TRAIN_PERSONA_BASE, TRAIN_WORLD_SEEDS
    train_p = {TRAIN_PERSONA_BASE + w * 1000 + i for w in TRAIN_WORLD_SEEDS for i in range(200)}
    eval_p = {EVAL_PERSONA_BASE + s * 1000 + i for s in range(1, 21) for i in range(200)}
    assert not train_p & eval_p
    assert not {EVAL_WORLD_BASE + s for s in range(1, 21)} & set(TRAIN_WORLD_SEEDS)


# ---- cards ------------------------------------------------------------------------------
def test_generator_is_deterministic_and_text_has_topic_vocabulary():
    a, la = generate_cards(3, 2)
    b, lb = generate_cards(3, 2)
    assert [c.id for c in a] == [c.id for c in b] and [c.body for c in a] == [c.body for c in b]
    assert len({c.category for c in a}) == 12 and len(a) == 2 * C.CARDS_PER_DAY
    assert all(c.word_count > 15 and c.importance > 1 for c in a)


def test_importance_formula_matches_ranking_md_example():
    assert abs(importance_of("fed", "government", 14) - 16.60) < 0.01     # docs/RANKING.md worked example A
    assert abs(importance_of("earnings", "filing", 6) - 7.24) < 0.01


def test_fixtures_load():
    cards = load_fixture_cards()
    assert len(cards) >= 20 and all(c.id and c.headline and c.category for c in cards)
    assert {c.category for c in cards} <= set(C.CATEGORIES)


# ---- stage 1, serving --------------------------------------------------------------------
def test_stage1_excludes_seen_disliked_hidden(env):
    emb, cat, _ = env
    now = cat.sort_at.max() - 20
    s = make_state(emb, cat, now)
    rows = cat.fresh_rows(now)
    victim = int(rows[5]); dis = int(rows[6]); hid_cat = cat.cards[int(rows[7])].category
    s.observe(cat.cards[victim], cat.emb[victim], [("view", None)], now)
    s.observe(cat.cards[dis], cat.emb[dis], [("view", None), ("dislike", None)], now)
    s.hidden_cats.add(hid_cat)
    elig = stage1.eligible_rows(s, cat, rows)
    ids = {cat.cards[r].id for r in elig}
    assert cat.cards[victim].id not in ids and cat.cards[dis].id not in ids
    assert all(cat.cards[r].category != hid_cat for r in elig)
    cands = stage1.candidates(s, cat, elig)
    assert set(cands) <= set(elig) and len(cands) <= C.K_COS + C.K_BASE
    best_base = elig[np.argmax(cat.base[elig])]
    assert best_base in cands                       # importance backstop


def test_rank_is_a_permutation_of_eligible_and_deterministic(env, tiny_heads):
    emb, cat, _ = env
    now = cat.sort_at.max() - 20
    rows = cat.fresh_rows(now)
    for variant in (Variant(), Variant("nogbdt", use_gbdt=False), Variant("plain", use_mmr=False, use_explore=False)):
        r = Ranker(tiny_heads, variant)
        s1, s2 = make_state(emb, cat, now), make_state(emb, cat, now)
        o1 = r.rank_rows(s1, cat, rows, now, None)
        o2 = r.rank_rows(s2, cat, rows, now, None)
        elig = stage1.eligible_rows(s1, cat, rows)
        assert sorted(o1.tolist()) == sorted(elig.tolist()) and len(set(o1.tolist())) == len(o1)
        assert o1.tolist() == o2.tolist()


def test_rank_for_you_public_api_returns_ids_and_short_why(env, tiny_heads):
    from elementml.serving import rank_for_you
    emb, cat, _ = env
    now = cat.sort_at.max() - 20
    rows = cat.fresh_rows(now)
    cards = [cat.cards[r] for r in rows]
    s = make_state(emb, cat, now)
    out = rank_for_you(s, cards, Ranker(tiny_heads), emb, now=now)
    ids = [r.id for r in out]
    assert len(ids) == len(set(ids)) and set(ids) <= {c.id for c in cards}
    assert all(0 < len(r.why) < 60 for r in out[:20])


def test_paging_is_stable_when_nothing_changes(env, tiny_heads):
    emb, cat, _ = env
    now = cat.sort_at.max() - 20
    rows = cat.fresh_rows(now)
    s = make_state(emb, cat, now)
    r = Ranker(tiny_heads)
    full = r.rank_rows(s, cat, rows, now, None).tolist()
    again = r.rank_rows(s, cat, rows, now, None).tolist()
    assert full == again
    pages = [full[i:i + 10] for i in range(0, len(full), 10)]
    flat = [x for p in pages for x in p]
    assert flat == full and len(set(flat)) == len(flat)       # no repeats across pages


# ---- diversity and exploration ----------------------------------------------------------
def test_mmr_spreads_near_duplicates():
    rng = np.random.default_rng(0)
    a = rng.normal(size=8); a /= np.linalg.norm(a)
    emb = np.vstack([a + 0.01 * rng.normal(size=8) for _ in range(5)] + [rng.normal(size=8) for _ in range(5)])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    util = np.array([1.0, 0.99, 0.98, 0.97, 0.96, 0.8, 0.7, 0.6, 0.5, 0.4])
    order = np.argsort(-util)
    out = rerank.mmr(order, util, emb, pool=10, lam=0.7)
    assert sorted(out.tolist()) == list(range(10))
    assert out[1] >= 5                                      # after the best card, the next pick is a different one
    assert len(set(out[:4]) & set(range(5))) <= 3           # plain utility order would put four near-copies first


def test_explore_slot_inserts_uncertain_good_card():
    util = np.linspace(1, 0, 30)
    unc = np.zeros(30); unc[12] = 1.0
    order = np.arange(30)
    out, flagged = rerank.explore_slots(order, util, unc, slots=(3,), beta=2.0)
    assert out[3] == 12 and 12 in flagged and sorted(out.tolist()) == list(range(30))


# ---- crowd privacy -----------------------------------------------------------------------
def test_crowd_aggregates_need_three_people(env):
    emb, cat, _ = env
    rows = cat.fresh_rows(cat.sort_at.max() - 5)[:12]
    now = float(cat.sort_at.max())

    def build(n_users):
        led = CrowdLedger(cat)
        for u in range(n_users):
            for r in rows[:6]:
                led.add(f"u{u}", int(r), [("view", None), ("like", None)], now - 2)
        return led.refresh(now)

    two, three = build(2), build(3)
    assert two.links.nnz == 0 and np.all(two.quality == 0) and np.all(two.lift == 0)
    assert three.links.nnz > 0 and np.any(three.quality != 0) or np.any(three.boost != 0)


# ---- baselines ---------------------------------------------------------------------------
def test_diversify_feed_port_matches_hand_trace_of_diversify_ts():
    # traced by hand from lib/diversify.ts (maxRun 2, window 5, index jump <= 6)
    assert diversify_feed([1, 1, 1, 2, 3]) == [0, 3, 1, 4, 2]
    assert diversify_feed([1, 1, 2, 2]) == [0, 2, 1, 3]
    cats = [1, 1, 1, 2, 2, 3, 1, 1, 2, 3]
    assert sorted(diversify_feed(cats)) == list(range(len(cats)))


def test_current_server_prefers_followed_topic_and_hides_disliked(env):
    emb, cat, _ = env
    now = cat.sort_at.max() - 20
    rows = cat.fresh_rows(now)
    pol = CurrentServer(cat)
    s = UserState("u", emb.k, follows=["energy"], now=now - 30)
    s.advance(now)
    order = pol.rank(s, rows, now, CrowdTables.empty(cat.n))
    top = [cat.cards[r].category for r in order[:10]]
    assert top.count("energy") >= 2
    dis = int(order[0])
    s.observe(cat.cards[dis], cat.emb[dis], [("view", None), ("dislike", None)], now)
    assert dis not in pol.rank(s, rows, now, CrowdTables.empty(cat.n)).tolist()


def test_recency_importance_is_the_stored_rank_score(env):
    emb, cat, _ = env
    now = cat.sort_at.max() - 20
    rows = cat.fresh_rows(now)
    s = UserState("u", emb.k)
    order = RecencyImportance(cat).rank(s, rows, now, None)
    sc = cat.base[order]
    assert np.all(sc[:-1] >= sc[1:])
