import sys, os
sys.path.insert(0, os.getcwd())
from textutil import word_count, shout
assert word_count("Hello, world!") == 2
assert word_count("don't stop") == 2
assert word_count("") == 0
assert word_count("  spaced   out  ") == 2
assert word_count("one - two") == 2
assert shout("hi") == "HI!"
