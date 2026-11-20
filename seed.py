"""Add a few example Mass Academy markets so the site isn't empty.

    python seed.py
"""

from datetime import datetime, timedelta

from app import connect, create_market, market_b

SAMPLES = [
    ("Will there be a snow day before winter break?", "Weather", 30,
     "Resolves Yes if Mass Academy cancels a full day of school due to weather before the first day of winter break.",
     ["Yes", "No"]),
    ("Will MAMS place top 3 at the regional Science Bowl?", "Competitions", 75,
     "Resolves Yes if the official regional results list Mass Academy in 1st, 2nd or 3rd place.",
     ["Yes", "No"]),
    ("Which month will have the first snow day?", "Weather", 100,
     "Resolves to the month of the first full-day weather cancellation this school year. "
     "\"None\" if there are no snow days by the end of March.",
     ["December", "January", "February", "March", "None"]),
    ("Will the STEM fair have more than 50 projects?", "Academics", 90,
     "Resolves Yes if more than 50 projects are presented at the Mass Academy STEM fair.",
     ["Yes", "No"]),
    ("Will the winter assembly run longer than 90 minutes?", "Events", 25,
     "Measured from scheduled start to dismissal.",
     ["Yes", "No"]),
]

if __name__ == "__main__":
    db = connect()
    existing = {r["question"] for r in db.execute("SELECT question FROM markets")}
    added = 0
    for question, category, days, description, outcomes in SAMPLES:
        if question in existing:
            continue
        closes = (datetime.now() + timedelta(days=days)).replace(hour=15, minute=0, second=0, microsecond=0)
        create_market(db, question, description, category, closes.strftime("%Y-%m-%d %H:%M:%S"),
                      outcomes, market_b("medium", len(outcomes)))
        added += 1
    print(f"Added {added} sample market(s).")
