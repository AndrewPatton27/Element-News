"""Every tunable number of the ML "For you" prototype, named in one place.

Input: nothing (plain constants). Output: imported as `C` by every other module.
Why one file: a value is changed here and nowhere else, and `SETTINGS_TABLE` lists the main ones for the docs.

Nothing here is read from the app or the database. The SIGNAL values start from the live server
weights (core.rank_params: w_like, w_dislike, w_open_detail, ...). Anything the live ranker does not
have is marked NEW. All times in the prototype are float hours.
"""

# ---- time -------------------------------------------------------------------------------
HOUR = 1.0                      # one hour (the unit of every time value)
DAY = 24.0                      # one day in hours

# ---- contract ---------------------------------------------------------------------------
CATEGORIES = ["markets", "earnings", "economy", "policy", "tech", "deals", "energy",
              "insider", "personal-finance", "world", "science", "safety"]   # contract/types.ts
EVENT_TYPES = ["earnings", "exec_change", "deal", "insider", "macro_release", "fed",
               "world_event", "recall", "science", "none"]
SOURCES = ["sec", "fed", "bea", "fred", "fedreg", "wikipedia", "cpsc", "usgs", "nasa", "none"]  # lib/sourceKeys.ts

# ---- importance (docs/RANKING.md section 4) ---------------------------------------------
EVENT_WEIGHT = {"fed": 8, "macro_release": 8, "earnings": 5, "deal": 4, "exec_change": 3,
                "insider": 2, "world_event": 3, "recall": 3, "science": 3, "none": 2}  # last 3 are guesses
AUTHORITY = {"government": 1.25, "filing": 1.0, "news": 0.8}    # multiplier by source authority
COVERAGE_K, COVERAGE_CAP = 0.25, 20   # coverage bonus 1 + K * ln(sources), sources capped at CAP
HALF_LIFE_H = 8.0               # rank_score = sort_at_h + 8*log2(importance): doubling importance = 8 h fresher

# ---- signal weights (live: core.rank_params w_*; the starting point for the vector) ------
SIGNAL = {"like": 1.0, "dislike": -1.0, "open_detail": 0.5, "open_source": 0.5,
          "long_look": 0.25, "quick_skip": -0.15, "view": 0.0}
DWELL_SKIP_MS = 1500            # dwell_skip_ms: at or under this (and no tap) is a quick skip
DWELL_WALKAWAY_MS = 120000      # dwell_walkaway_ms: over this the reader walked away (no information)
DWELL_LONG_MS, DWELL_LONG_MIN_MS, DWELL_MS_PER_WORD = 8000, 6000, 150   # long look = clamp(words x 150, 6 s, 8 s)
CARD_CAP_POS, CARD_CAP_NEG = 1.5, -1.0   # one card's total signal is clipped to this range
SIGNAL_HALF_LIFE_DAYS = 14.0    # signal_half_life_days: affinity evidence halves every 14 days
AFF_CAP = {"category": 4.0, "type": 1.0, "source": 1.0}   # affinity cap in hours per dimension
AFF_PRIOR_CARDS = 0.25          # confidence = cards / (cards + this)
NEG_SCALE = 2.0                 # foryou_negative_scale: negative affinities count double

# ---- item embedding (NEW) ---------------------------------------------------------------
EMB_DIMS = 32                   # item vector size
EMB_ONEHOT_WEIGHT = 0.35        # weight of the one-hot category / event / source columns vs TF-IDF
EMB_MAX_FEATURES = 6000         # TF-IDF vocabulary size

# ---- user vector (NEW) ------------------------------------------------------------------
UV_ETA0 = 0.55                  # first-event step
UV_TAU = 4.0                    # evidence at which the step has halved: eta = eta0 / (1 + n/tau)
UV_ETA_MIN = 0.04               # the step never falls below this
UV_HALF_LIFE_DAYS = 14.0        # vector decays toward the cold-start prior
UV_PRIOR_NORM = 0.6             # length of the prior built from followed topics
UV_MAX_NORM = 1.0               # the vector is clipped to this length
UV_PREC_GAIN = 1.0              # uncertainty: precision grows by gain*|s|*dims*x_d^2 per event
STATIC_STEP = 0.12              # ablation: fixed step instead of shrinking
# hardening: recursive-least-squares reader model (a full-covariance Kalman filter on a linear reward model)
RLS_LAMBDA = 2.0                # prior strength (ridge penalty), in "impressions"
RLS_PRIOR_SCALE = 0.5           # the follow prior's direction, scaled into reward units
RLS_HALF_LIFE_DAYS = 14.0       # evidence fades toward the prior with the same half-life as the vector

# ---- stage 1 ----------------------------------------------------------------------------
WINDOW_H = 72.0                 # freshness window
K_COS = 120                     # cosine top-K
K_BASE = 60                     # plus the best by base rank_score (importance backstop)

# ---- stage 2 ----------------------------------------------------------------------------
LGB_PARAMS = dict(learning_rate=0.05, num_leaves=15, min_data_in_leaf=60, feature_fraction=0.8,
                  bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0, seed=7, num_threads=1,
                  deterministic=True, force_row_wise=True, verbose=-1)   # single thread + seed = same trees every run
LGB_ROUNDS = {"like": 220, "dislike": 160, "detail": 200, "time": 220}   # boosting rounds per head
READ_MS_PER_WORD_REF = 150.0    # completion = dwell / (words * this); ranker-visible
COMPLETION_CAP = 2.0            # completion labels and predictions are capped here

# expected utility = W_LIKE*p_like + W_TIME*completion/1.2 + W_DETAIL*p_detail - W_DISLIKE*p_dislike + W_BASE*base
W_LIKE = 1.0
W_TIME = 0.4                    # relative to the card's own length and capped: no reward for long cards
W_DETAIL = 0.5
W_DISLIKE = 1.5
W_BASE = 0.15                   # importance/freshness guard (units: like-probability per 24 h of base score)
TIME_CAP = 1.2                  # completion above this earns nothing more

# ---- diversity + exploration (NEW) ------------------------------------------------------
MMR_LAMBDA = 0.78               # MMR: 0.78 x utility - 0.22 x similarity to cards already picked
MMR_POOL = 40                   # MMR re-ranks only the best 40
EXPLORE_SLOTS = (3, 8)          # 0-based slots 4 and 9 of a page
EXPLORE_BETA = 0.9              # UCB: utility_norm + beta * uncertainty_norm
EXPLORE_MIN_EVENTS = 2.0        # evidence needed before exploration starts (cold users already get diversity)
PAGE_SIZE = 10                  # cards per page (metrics are computed on the first page)

# ---- crowd (mirrors the live collab / trending tables) ----------------------------------
CROWD_MIN_USERS = 3             # privacy floor: no crowd number from fewer than 3 people
# Trending buzz: 48 h window, at most +6 h / -3 h, half the maximum at 8 points, at least 2 readers
TREND_WINDOW_H, TREND_MAX_H, TREND_MAX_NEG_H, TREND_HALF_POINTS, TREND_MIN_USERS = 48.0, 6.0, 3.0, 8.0, 2
TREND_W = {"like": 3.0, "open_detail": 2.0, "open_source": 2.0, "long": 1.0, "view": 0.2, "dislike": 3.0}  # buzz points
COLLAB_WINDOW_DAYS, COLLAB_HALF_LIFE_DAYS = 14.0, 7.0       # crowd tables look back 14 days, fading over 7
# card neighbours: similarity shrink, neighbours kept per card, max hours of boost, link value at half boost
COLLAB_CARD_SHRINK, COLLAB_CARD_NEIGHBORS, COLLAB_CARD_HOURS, COLLAB_CARD_HALF = 5.0, 20, 4.0, 0.5
COLLAB_TOPIC_MIN_POS, COLLAB_TOPIC_PRIOR_N, COLLAB_TOPIC_HOURS = 2, 20.0, 2.0   # topic lift: likes to join, prior, hours
COLLAB_QUALITY_PRIOR_N, COLLAB_QUALITY_HOURS = 10.0, 2.0                       # quality boost: prior views, max hours
COLLAB_MAX_PER_USER = 50        # at most the 50 newest positive cards per reader feed the neighbours

# ---- live server For-you v4 (supabase/migrations/20261018010000_algo_v2.sql) ------------
SQL = dict(seen_penalty=100.0, seen_view_penalty=24.0, explore_hours=1.0, explore_min_events=5,
           category_step=0.75, personal_scale=3.0, boost_followed_hours=2.0, cold_step=4.0,
           cold_events=5, affinity_days=30.0)

# ---- device formula (lib/forYouRank.ts FY + lib/localRank.ts RANK) ----------------------
FY = dict(seenPenalty=12, reactedPenalty=20, coldReactions=3, overlapWindow=5, overlapMax=2,
          overlapTop3=10, overlapTop10=6, likeHalfLifeDays=14, dislikeSpill=4, spillLast=3,
          exploreFirst=4, exploreEvery=6, exploreMinReactions=3, topicCap=3, topicCapWindow=10,
          tasteWeight=8)
RANK = dict(favorite=24, likeTopic=8, likeSource=4, dislikeTopic=8, dislikeSource=4, maxCount=3)

# ---- simulation -------------------------------------------------------------------------
CARDS_PER_DAY = 120             # synthetic cards published per day
SESSION_HOURS = (8.0, 13.0, 20.0)   # the three possible session times of a day
MAX_SESSION_CARDS = 40          # a session never shows more than this

SETTINGS_TABLE = [
    # (name, value, what it does)
    ("EMB_DIMS", EMB_DIMS, "item vector size (TF-IDF + one-hot -> SVD)"),
    ("UV_ETA0 / UV_TAU", f"{UV_ETA0} / {UV_TAU}", "user-vector step = eta0 / (1 + evidence / tau), floor UV_ETA_MIN"),
    ("UV_HALF_LIFE_DAYS", UV_HALF_LIFE_DAYS, "the user vector decays toward the follow prior"),
    ("UV_PRIOR_NORM", UV_PRIOR_NORM, "length of the cold-start prior from followed topics"),
    ("K_COS / K_BASE", f"{K_COS} / {K_BASE}", "stage 1: cosine top-K plus best-by-base-score backstop"),
    ("WINDOW_H", WINDOW_H, "stage 1 freshness window (hours)"),
    ("W_LIKE", W_LIKE, "utility weight on p(like)"),
    ("W_TIME", W_TIME, "utility weight on expected completion (dwell / words x 150 ms, capped)"),
    ("W_DETAIL", W_DETAIL, "utility weight on p(open detail)"),
    ("W_DISLIKE", W_DISLIKE, "utility penalty on p(dislike)"),
    ("W_BASE", W_BASE, "importance/freshness guard, per 24 h of base score"),
    ("MMR_LAMBDA / MMR_POOL", f"{MMR_LAMBDA} / {MMR_POOL}", "diversity re-rank trade-off and pool size"),
    ("EXPLORE_SLOTS / BETA", f"{EXPLORE_SLOTS} / {EXPLORE_BETA}", "slots reserved for the most uncertain good card, UCB weight"),
    ("EXPLORE_MIN_EVENTS", EXPLORE_MIN_EVENTS, "evidence before exploration slots start"),
]
