# openapi2rpc-ts

**手元の `openapi.yaml` だけで、gRPC ライクな TypeScript クライアントを作るツールです。**

gRPC の「サービス・メッセージ・ステータスコード」という書き心地は好きでも、実際に使おうとすると手間がかかります。

- API 定義とは別に、`.proto` を書いて管理する
- `protoc` や `buf`、言語ごとのプラグインをそろえ、バージョンを合わせる
- サーバーを gRPC / Connect に対応させ、ブラウザから呼ぶなら中継（grpc-web や Envoy など）も用意する
- 今ある REST API は、そもそもこの仕組みに乗せられない

openapi2rpc-ts は、この手間を全部省いて **書き心地だけ**を持ってきます。

```bash
npx openapi2rpc-ts -i openapi.yaml -o src/gen/api.ts
```

```ts
import { createClients, createFetchTransport, Code, RpcError, TaskStatus } from './gen/api.js';

const { tasks } = createClients(createFetchTransport({ baseUrl: 'https://api.example.com/v1' }));

try {
  const page = await tasks.listTasks({ projectId: 'p1', status: [TaskStatus.TODO] }, { timeoutMs: 3000 });
  for (const t of page.tasks) console.log(t.title);
} catch (err) {
  if (err instanceof RpcError && err.code === Code.NOT_FOUND) {
    // HTTP ステータスではなく、意味（gRPC のコード）で分岐できる
  }
}
```

- 入力は、たいていすでにある `openapi.yaml` だけです。proto も protoc も要りません。
- 出力は TS ファイル 1 つで、実行時に必要なパッケージもありません。
- サーバーは今の REST API のままで、通信も普通の HTTP/JSON（fetch）です。

## gRPC との比較

| | gRPC / Connect | openapi2rpc-ts |
|---|---|---|
| 定義 | `.proto` を新たに書く | 既存の `openapi.yaml` |
| ツール | protoc / buf / プラグイン | `npx` 1 回 |
| サーバー側 | gRPC / Connect 対応が必要 | 変更なし（既存の REST API のまま） |
| ブラウザ | grpc-web / Connect が必要 | fetch で動く |
| 呼び出し | `client.getTask(request)` | `client.getTask(request)` |
| エラー | ステータスコード | ステータスコード（HTTP から自動変換） |
| deadline / cancel / interceptor | あり | あり |
| バイナリ形式・ストリーミング | あり | なし（HTTP/JSON の 1 往復のみ） |

通信の効率化やストリーミングといった gRPC の**通信そのもの**の利点はあきらめて、**呼び方とエラーの扱い方**の統一に絞っています。フロントエンドや一般的な API 連携で困るのは、たいてい後者だからです。

## 書き心地

- tag ごとに **サービス**（`TasksService`）を作る
- 各 API は **1 リクエスト・1 レスポンス**のメソッド（`getTask(request): Promise<GetTaskResponse>`）
- path / query / header パラメータと body を **1 つのリクエストメッセージ**にまとめる
- エラーは HTTP ステータスではなく **gRPC ステータスコード**（`Code.NOT_FOUND` など）で扱う
- 呼び出しごとの **CallOptions**（metadata / deadline / cancel）と **インターセプター**が使える
- `Transport` はメソッドが 1 つだけなので、テスト用のモックも簡単に作れる

## 使い方

```bash
npx openapi2rpc-ts -i openapi.yaml -o src/gen/api.ts
```

| オプション | 説明 |
|---|---|
| `-i, --input <file>` | OpenAPI 定義（YAML / JSON）。`-` で標準入力から読む |
| `-o, --output <file>` | 出力先（省略時は標準出力） |
| `--runtime-import <module>` | ランタイムを埋め込まず、指定モジュールから import する |
| `--emit-runtime <file>` | ランタイムを別ファイルとして書き出す |

デフォルトでは、ランタイム（`Code` / `RpcError` / `createFetchTransport` など）を生成ファイルに埋め込みます。そのため、出力ファイルは 1 つで完結し、実行時の依存パッケージもありません。

複数の API 定義からクライアントを作るときは、ランタイムを 1 ファイルにまとめて共有できます。

```bash
npx openapi2rpc-ts --emit-runtime src/gen/rpc-runtime.ts
npx openapi2rpc-ts -i users.yaml -o src/gen/users.ts --runtime-import ./rpc-runtime.js
npx openapi2rpc-ts -i billing.yaml -o src/gen/billing.ts --runtime-import ./rpc-runtime.js
```

プログラムからも呼べます。

```ts
import { generateFromText } from 'openapi2rpc-ts';

const { code, warnings } = generateFromText(yamlText, { runtimeImport: './rpc-runtime.js' });
```

## 生成されるもの

[`test/fixtures/petstore.yaml`](test/fixtures/petstore.yaml) から生成した [`test/fixtures/petstore.generated.ts`](test/fixtures/petstore.generated.ts) が実例です。

| OpenAPI | 生成される TypeScript |
|---|---|
| `components.schemas` | メッセージ型（object は `interface`、それ以外は `type`） |
| 文字列の `enum` | union 型と、同名の定数オブジェクト（`PetStatus.AVAILABLE`） |
| tag | サービスのインターフェース `XxxService` / HTTP 対応表 `XxxServiceDefinition` / クライアント `XxxServiceClient` |
| operation | `XxxRequest` / `XxxResponse` とメソッド |
| 全体 | `createClients(transport)`（全サービスのクライアントをまとめて作る） |

```ts
/** Request message for `getPet`. */
export interface GetPetRequest {
  /** @in path `petId` */
  petId: number;
}
export type GetPetResponse = Pet;

export interface PetsService {
  /** Get a pet — `GET /pets/{petId}` */
  getPet(request: GetPetRequest, options?: CallOptions): Promise<GetPetResponse>;
  // ...
}
```

### 命名ルール

- **サービス名**：最初の tag を PascalCase にして `Service` を付けます。tag がない操作は `DefaultService` に入ります。
- **メソッド名**：`operationId` を camelCase にしたものです。`operationId` がなければ、メソッドとパスから作ります（`POST /pets/{petId}/photo` → `postPetsPhotoByPetId`）。
- **リクエストのフィールド名**：パラメータ名を camelCase にします（`X-Request-Id` → `xRequestId`）。HTTP 上の元の名前は `XxxServiceDefinition` に残ります。
- **body**：`body` フィールドに入ります（JSON / `multipart/form-data` / `x-www-form-urlencoded` / テキスト / バイナリ）。
- **レスポンス**：最初の 2xx レスポンスの型です。中身がなければ `Empty`（`google.protobuf.Empty` 相当）になります。
- **名前の衝突回避**：グローバルやランタイムの名前と衝突するスキーマ名は、`Model` を付けて避けます（`Error` → `ErrorModel`）。

### 型の対応

| JSON Schema | TypeScript |
|---|---|
| `string`（`format: binary`） | `string`（`Blob`） |
| `integer` / `number` | `number` |
| `array` | `T[]` |
| `object` + `additionalProperties` | `Record<string, T>` |
| `oneOf` / `anyOf` | union |
| `allOf` | intersection |
| `nullable: true`（3.0） / `type: [T, 'null']`（3.1） | `T \| null` |
| `const` / `enum` | リテラル型 |

## ランタイム

### HTTP ステータスと gRPC コードの対応

| HTTP | Code |
|---|---|
| 400 | `INVALID_ARGUMENT` |
| 401 | `UNAUTHENTICATED` |
| 403 | `PERMISSION_DENIED` |
| 404 | `NOT_FOUND` |
| 408, 504 | `DEADLINE_EXCEEDED` |
| 409 | `ABORTED` |
| 412 | `FAILED_PRECONDITION` |
| 416 | `OUT_OF_RANGE` |
| 429 | `RESOURCE_EXHAUSTED` |
| 499 | `CANCELLED` |
| 501 | `UNIMPLEMENTED` |
| 502, 503 | `UNAVAILABLE` |
| その他の 4xx / 5xx | `FAILED_PRECONDITION` / `INTERNAL` |

そのほかの失敗も次のコードになります。

- **通信エラー**：`UNAVAILABLE`
- **`timeoutMs` 超過**：`DEADLINE_EXCEEDED`
- **`signal` によるキャンセル**：`CANCELLED`

エラーレスポンスの本文は `RpcError.details` に、レスポンスヘッダーは `RpcError.metadata` に入ります。

### インターセプター

```ts
const logging: Interceptor = (next) => async (req) => {
  const started = Date.now();
  try {
    return await next(req);
  } finally {
    console.log(`${req.method.service}/${req.method.name}`, Date.now() - started, 'ms');
  }
};

createFetchTransport({ baseUrl, interceptors: [logging] }); // 配列の先頭が一番外側
```

### テスト用のトランスポート

`Transport` はメソッドが 1 つだけのインターフェースです。HTTP を使わないモックも簡単に作れます。

```ts
const clients = createClients({
  async unary(method, request) {
    if (method.name === 'getPet') return { id: 1, name: 'Pochi', status: 'available' };
    throw new RpcError(Code.UNIMPLEMENTED, method.name);
  },
});
```

生成コードは `strict` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax` などを有効にしても型エラーが出ません。TypeScript 4.9 以上（`satisfies` を使うため）と、`fetch` / `AbortController` / `FormData` が使える環境（Node.js 18 以上 / モダンブラウザ）が必要です。

## 未対応（今後の候補）

- 外部ファイルへの `$ref`（`./other.yaml#/...`）
- Swagger 2.0
- ストリーミング（SSE など）
- サーバー側のスタブ生成
- `int64` を `bigint` / `string` にするオプション

## 開発

```bash
npm install
npm test          # vitest（スナップショット、生成コードの型チェック、ランタイムの動作）
npm run typecheck
npm run build
npm run generate:example   # test/fixtures/petstore.generated.ts を作り直す
```

スナップショットを更新するときは `npx vitest run -u` を実行します。
