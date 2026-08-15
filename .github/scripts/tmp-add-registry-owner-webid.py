from pathlib import Path


def replace_exact(path, old, new, expected, label):
    text = path.read_text()
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f"{label}: expected {expected}, found {actual}")
    path.write_text(text.replace(old, new))

blocked = Path('pod-provider/backend/services/activitypub-blocked-collection.service.js')
muted = Path('pod-provider/backend/services/activitypub-muted-collection.service.js')
regression = Path('pod-provider/backend/tests/activitypub-collection-dataset-context.test.js')
blocked_test = Path('pod-provider/backend/tests/activitypub-blocked-collection.test.js')
muted_test = Path('pod-provider/backend/tests/activitypub-muted-collection.test.js')

replace_exact(
    blocked,
    '{ meta: { dataset } }',
    '{ meta: { webId: actorUri, dataset } }',
    2,
    'blocked registry owner context',
)
replace_exact(
    muted,
    '{ meta: { dataset } }',
    '{ meta: { webId: actorUri, dataset } }',
    1,
    'muted registry owner context',
)
replace_exact(
    regression,
    "expect(call.options).toEqual({ meta: { dataset: DATASET } });",
    "expect(call.options).toEqual({ meta: { webId: ACTOR_URI, dataset: DATASET } });",
    1,
    'registry regression owner context',
)
replace_exact(
    blocked_test,
    "{ meta: { dataset: 'alice' } }",
    "{ meta: { webId: 'https://fed.example.com/users/alice', dataset: 'alice' } }",
    2,
    'blocked startup owner context',
)
replace_exact(
    muted_test,
    "{ meta: { dataset: 'alice' } }",
    "{ meta: { webId: 'https://fed.example.com/users/alice', dataset: 'alice' } }",
    1,
    'muted startup owner context',
)
