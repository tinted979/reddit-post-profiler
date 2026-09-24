import pytest

from reddit_tool.analyze import parse_post_ref


@pytest.mark.parametrize(
    "ref",
    [
        "https://www.reddit.com/r/Python/comments/abc123/some_title/",
        "https://old.reddit.com/r/Python/comments/ABC123/some_title/def456/?context=3",
        "reddit.com/r/Python/comments/abc123",
        "https://new.reddit.com/comments/abc123?utm=x",
        "https://redd.it/abc123",
        "t3_abc123",
        "abc123",
        "  abc123  ",
    ],
)
def test_parse_post_ref(ref):
    assert parse_post_ref(ref) == "abc123"


@pytest.mark.parametrize(
    "ref", ["", "https://www.reddit.com/r/Python/", "not a post!", "https://reddit.com/r/x/s/AbCdEf"]
)
def test_parse_post_ref_invalid(ref):
    with pytest.raises(ValueError):
        parse_post_ref(ref)


def test_cli_exclude_is_repeatable_and_keeps_post():
    from reddit_tool.cli import build_parser

    args = build_parser().parse_args(["--exclude", "a", "--exclude", "b", "abc123"])
    assert args.exclude == ["a", "b"] and args.post == "abc123"
