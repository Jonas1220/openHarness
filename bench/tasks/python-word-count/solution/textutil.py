import re


def shout(text):
    return text.upper() + "!"


def word_count(text):
    return len(re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?", text))
