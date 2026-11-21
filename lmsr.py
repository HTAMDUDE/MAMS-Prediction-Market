"""Logarithmic Market Scoring Rule (LMSR) automated market maker.

The market maker always quotes a price for every outcome, so traders never
need a counterparty. Prices across all outcomes of a market always sum to 1,
and each price can be read as the crowd's probability for that outcome.

    cost(q)  = b * ln( sum_i exp(q_i / b) )
    price_i  = exp(q_i / b) / sum_j exp(q_j / b)

q_i is the number of shares of outcome i sold so far and b is the
"liquidity" parameter: larger b means prices move less per trade.
A winning share pays out 1 coin when the market resolves.
"""

import math


def _logsumexp(xs):
    m = max(xs)
    return m + math.log(sum(math.exp(x - m) for x in xs))


def cost(q, b):
    return b * _logsumexp([x / b for x in q])


def prices(q, b):
    z = [x / b for x in q]
    m = max(z)
    e = [math.exp(v - m) for v in z]
    total = sum(e)
    return [v / total for v in e]


def shares_for_amount(q, b, i, amount):
    """How many shares of outcome i can be bought for exactly `amount` coins."""
    if amount <= 0:
        raise ValueError("amount must be positive")
    # Solving cost_for_shares(s) = amount gives exp(s/b) = 1 + (exp(amount/b) - 1) / p_i. Evaluated in log
    # space so it stays accurate for tiny amounts and for outcomes priced near 0.
    x = amount / b
    neg_log_p = (cost(q, b) - q[i]) / b  # = -ln(p_i)
    a = neg_log_p + x + math.log(-math.expm1(-x))
    return b * (max(a, 0.0) + math.log1p(math.exp(-abs(a))))  # b * ln(1 + e^a)


def cost_for_shares(q, b, i, shares):
    """Coins needed to buy `shares` of outcome i."""
    q2 = list(q)
    q2[i] += shares
    return cost(q2, b) - cost(q, b)


def sell_value(q, b, i, shares):
    """Coins received for selling `shares` of outcome i back to the market maker."""
    q2 = list(q)
    q2[i] -= shares
    return cost(q, b) - cost(q2, b)


def liquidation_value(q, b, holdings):
    """Coins received for selling a whole set of holdings (one share count per outcome) at once.

    This is not the sum of per-outcome sell values: holding s of every outcome is worth exactly s."""
    return cost(q, b) - cost([x - h for x, h in zip(q, holdings)], b)
