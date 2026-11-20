"""Add a few example Mass Academy markets so the site isn't empty.

    python seed.py
"""

from datetime import datetime, timedelta

from app import connect, create_market, market_b

# (question, category, days until close, resolves-if rules, source, otherwise, outcomes)
SAMPLES = [
    ("Will there be a snow day before winter break?", "Weather", 30,
     "Resolves YES if Mass Academy cancels a full day of school due to weather before the first day of winter break.",
     "The school's official closing announcement (email or website).",
     "A delayed opening or early dismissal does not count. If winter break is moved, the new first day is used.",
     ["Yes", "No"]),
    ("Will MAMS place top 3 at the regional Science Bowl?", "Competitions", 75,
     "Resolves YES if the official regional results list Mass Academy in 1st, 2nd or 3rd place.",
     "The official regional Science Bowl results page.",
     "If the event is cancelled or postponed past the closing date, this resolves NO.",
     ["Yes", "No"]),
    ("Which month will have the first snow day?", "Weather", 100,
     "The winner is the month of the first full-day weather cancellation this school year.",
     "The school's official closing announcement.",
     "\"None\" wins if there are no snow days by the end of March.",
     ["December", "January", "February", "March", "None"]),
    ("Will the STEM fair have more than 50 projects?", "Academics", 90,
     "Resolves YES if more than 50 projects are presented at the Mass Academy STEM fair.",
     "The official project list published by the organizers.",
     "Projects withdrawn before the fair don't count. If the fair is postponed past the closing date, this resolves NO.",
     ["Yes", "No"]),
    ("Will the winter assembly run longer than 90 minutes?", "Events", 25,
     "Resolves YES if the assembly lasts longer than 90 minutes, measured from scheduled start to dismissal.",
     "The posted assembly schedule, and the time on the clock at dismissal.",
     "If the assembly is cancelled, this resolves NO.",
     ["Yes", "No"]),
]

if __name__ == "__main__":
    db = connect()
    existing = {r["question"] for r in db.execute("SELECT question FROM markets")}
    added = 0
    for question, category, days, description, source, otherwise, outcomes in SAMPLES:
        if question in existing:
            continue
        closes = (datetime.now() + timedelta(days=days)).replace(hour=15, minute=0, second=0, microsecond=0)
        create_market(db, question, description, category, closes.strftime("%Y-%m-%d %H:%M:%S"),
                      outcomes, market_b("medium", len(outcomes)), None, source, otherwise)
        added += 1
    print(f"Added {added} sample market(s).")
