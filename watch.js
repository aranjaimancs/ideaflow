import "dotenv/config";

const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_IDEAS_LIST_ID } = process.env;

if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_IDEAS_LIST_ID) {
  console.error(
    "Missing required env vars: TRELLO_KEY, TRELLO_TOKEN, TRELLO_IDEAS_LIST_ID"
  );
  process.exit(1);
}

const BASE = "https://api.trello.com/1";

async function trelloGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("key", TRELLO_KEY);
  url.searchParams.set("token", TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API error ${res.status} for ${path}: ${text}`);
  }
  return res.json();
}

async function getUnprocessedCards(listId) {
  const cards = await trelloGet(`/lists/${listId}/cards`, {
    fields: "id,name,desc,labels",
  });

  return cards.filter(
    (card) =>
      !card.labels.some(
        (label) => label.name.toLowerCase() === "processed"
      )
  );
}

const cards = await getUnprocessedCards(TRELLO_IDEAS_LIST_ID);

if (cards.length === 0) {
  console.log("No unprocessed cards found.");
} else {
  for (const { id, name, desc } of cards) {
    console.log(JSON.stringify({ id, name, desc }));
  }
}
