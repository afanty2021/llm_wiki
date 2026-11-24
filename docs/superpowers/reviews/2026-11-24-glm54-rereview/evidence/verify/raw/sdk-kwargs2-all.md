## SDK 资源方法签名（钉版实测）
- `chat.completions.create`：关键字参数 39 个（同步/异步变体一致）；含 `context_management`=False，含 `extra_body`=True，含 `stream`=True
- `responses.create`：关键字参数 33 个（同步/异步变体一致）；含 `context_management`=True，含 `extra_body`=True，含 `stream`=True
- `messages.create`：关键字参数 22 个（同步/异步变体一致）；含 `context_management`=False，含 `extra_body`=True，含 `stream`=True
- `messages.stream`：关键字参数 22 个（同步/异步变体一致）；含 `context_management`=False，含 `extra_body`=True，含 `stream`=False
- `chat.completions.parse`：关键字参数 38 个（同步/异步变体一致）；含 `context_management`=False，含 `extra_body`=True，含 `stream`=False
- `beta.chat.completions.parse`：关键字参数 38 个（同步/异步变体一致）；含 `context_management`=False，含 `extra_body`=True，含 `stream`=False

## 调用点
- 资源方法调用点 39 处：直接 kwargs 13 处、`**变量` 展开 26 处
- 需人工复核（键不在钉版签名 / 动态键）：8 处
  - `agent/chat_completion_helpers.py:787` [chat.completions.create] 键不在签名: ['_moa_prepared_request'] 
  - `evals/output_caps_local_capture.py:81` [chat.completions.create] 模块级 `**` 展开，未跟踪 
  - `evals/output_caps_local_capture.py:84` [chat.completions.create] 模块级 `**` 展开，未跟踪 
  - `evals/output_caps_local_capture.py:71` [chat.completions.create] 模块级 `**` 展开，未跟踪 
  - `evals/output_caps_local_capture.py:75` [chat.completions.create] 模块级 `**` 展开，未跟踪 
  - `evals/output_caps_local_capture.py:96` [chat.completions.create] 模块级 `**` 展开，未跟踪 
  - `evals/provider_wire/issue_103944.py:136` [chat.completions.create] 模块级 `**` 展开，未跟踪 
  - `evals/provider_wire/issue_104359.py:157` [chat.completions.create] 模块级 `**` 展开，未跟踪 
