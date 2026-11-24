import sys, os
sys.path.insert(0, '/Users/berton/Github/Coding-Agents/hermes-merge-20261108')
os.chdir('/Users/berton/Github/Coding-Agents/hermes-merge-20261108')
from tools.terminal_tool import _preprocess_command_for_adaptive_timeout as f
cases = ["git clone https://github.com/o/r.git", "cd /tmp/x && git clone https://github.com/o/r.git", "git -C /tmp/x clone https://github.com/o/r.git",
         "gh repo clone owner/repo", "gh repo fork owner/repo --clone", "git clone --quiet https://github.com/o/r.git", "git clone --progress https://github.com/o/r.git",
         "pip install -r requirements.txt", "npm install", "docker pull python:3.11", "curl -sSo out.bin https://example.com/big", "sleep 90; echo done", "git fetch --all"]
for c in cases:
    out = f(c); print(('CHANGED ' if out != c else 'same    ') + c[:70] + ('   =>  ' + out[:90] if out != c else ''))
