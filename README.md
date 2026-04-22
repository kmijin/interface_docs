# 시스템 인터페이스 정의서 생성기

Swagger(OpenAPI) 명세를 입력하면 **Word(.docx)**, **Markdown(.md)**, **Confluence 페이지**를 자동으로 생성하는 도구입니다.

## 주요 기능

- **Word 문서 생성** — Swagger JSON/YAML을 파싱해 시스템 인터페이스 정의서(.docx) 생성
- **Markdown 생성** — 동일 구조의 .md 파일 생성
- **Confluence 업로드** — Confluence REST API를 통해 태그별 하위 페이지 자동 생성·업데이트
- **템플릿 적용** — 기존 .docx 양식을 분석해 폰트·색상·레이아웃을 문서에 반영
- **URL에서 직접 불러오기** — Swagger URL 입력 시 자동 fetch 후 처리

## 시작하기

### 설치

```bash
npm install
```

### 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000` 접속

### Confluence 연동 설정

프로젝트 루트에 `confluence.config.json` 파일을 생성합니다. (`.gitignore`에 포함됨 — **절대 커밋 금지**)

```json
{
  "baseUrl": "https://<your-domain>.atlassian.net",
  "email": "your-email@example.com",
  "token": "your-atlassian-api-token",
  "defaultSpaceKey": "SPACE_KEY",
  "defaultParentPageId": ""
}
```

> Atlassian API 토큰 발급: https://id.atlassian.com/manage-profile/security/api-tokens

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/generate` | Swagger → .docx 다운로드 |
| `POST` | `/generate-md` | Swagger → .md 다운로드 |
| `POST` | `/fetch-swagger` | URL에서 Swagger JSON fetch |
| `POST` | `/analyze-template` | .docx 템플릿 분석 (폰트·색상 추출) |
| `POST` | `/confluence-upload` | Confluence 페이지 생성·업데이트 |
| `POST` | `/confluence-proxy` | Confluence CORS 우회 프록시 |
| `GET`  | `/confluence-config` | Confluence 설정 확인 (token 제외) |

## 프로젝트 구조

```
.
├── server.js                     # Express 서버, API 라우터
├── lib/
│   ├── generate_from_swagger.js  # Swagger → .docx 변환
│   ├── generate_markdown.js      # Swagger → .md 변환
│   ├── generate_confluence.js    # Swagger → Confluence XHTML 변환
│   ├── analyze_template.js       # .docx 템플릿 프로파일 분석
│   └── supplement_external.js    # 외부 $ref 문서 보완
├── public/
│   └── index.html                # 웹 UI
├── confluence.config.json        # Confluence 인증 정보 (gitignore됨)
└── Dockerfile
```

## Docker

```bash
docker build -t inf-generator .
docker run -p 3000:3000 inf-generator
```

## 기술 스택

- **Runtime**: Node.js
- **Framework**: Express 5
- **문서 생성**: docx
- **YAML 파싱**: js-yaml
- **파일 업로드**: multer
