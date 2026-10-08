"""Fills a development database with sample people and teams."""

import random

FIRST = ["Ada", "Grace", "Linus", "Margaret", "Edsger", "Barbara"]
LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Dijkstra", "Liskov"]
TEAMS = ["platform", "billing", "search", "mobile"]


def sample_people(count: int, seed: int = 7) -> list[dict[str, str]]:
    rng = random.Random(seed)
    people = []
    for index in range(count):
        first, last = rng.choice(FIRST), rng.choice(LAST)
        people.append(
            {
                "name": f"{first} {last}",
                "email": f"{first.lower()}.{last.lower()}{index}@example.test",
                "team": rng.choice(TEAMS),
            }
        )
    return people


if __name__ == "__main__":
    for person in sample_people(20):
        print(person["email"], person["team"])
