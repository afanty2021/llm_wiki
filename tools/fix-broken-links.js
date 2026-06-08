#!/usr/bin/env node

/**
 * 自动修复 LLM Wiki 项目中的可修复断链
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目配置
const projects = [
  {
    name: 'Invest',
    path: '/Users/berton/Documents/Invest/Invest',
    lintFile: '/Users/berton/Documents/Invest/Invest/.llm-wiki/lint.json',
    wikiPath: '/Users/berton/Documents/Invest/Invest/wiki'
  },
  {
    name: 'English-Teaching',
    path: '/Users/berton/Documents/English-Teaching',
    lintFile: '/Users/berton/Documents/English-Teaching/.llm-wiki/lint.json',
    wikiPath: '/Users/berton/Documents/English-Teaching/wiki'
  }
];

// 文件名匹配模式
const patterns = [
  (name) => `${name}.md`,
  (name) => `${name.toLowerCase()}.md`,
  (name) => `${name.replace(/\s+/g, '-')}.md`,
  (name) => `${name.replace(/\s+/g, '_')}.md`,
  (name) => `entities/${name}.md`,
  (name) => `concepts/${name}.md`,
  (name) => `sources/${name}.md`,
  (name) => `queries/${name}.md`,
];

function findPageByTitle(wikiPath, title) {
  for (const pattern of patterns) {
    const fileName = pattern(title);
    const filePath = path.join(wikiPath, fileName);
    if (fs.existsSync(filePath)) {
      return { path: filePath, name: fileName };
    }
  }

  // 模糊搜索 - 搜索所有 md 文件
  const allFiles = [];
  function searchDir(dir, relativePath = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          searchDir(path.join(dir, entry.name), path.join(relativePath, entry.name));
        } else if (entry.name.endsWith('.md')) {
          allFiles.push({
            fullPath: path.join(dir, entry.name),
            relativePath: path.join(relativePath, entry.name),
            fileName: entry.name
          });
        }
      }
    } catch (e) {
      // 忽略无法读取的目录
    }
  }

  searchDir(wikiPath);

  // 尝试模糊匹配
  const normalizedTitle = title.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[（）()]/g, '')
    .replace(/[，,]/g, '');

  for (const file of allFiles) {
    const normalizedFileName = file.fileName.toLowerCase()
      .replace('.md', '')
      .replace(/\s+/g, '-')
      .replace(/[（）()]/g, '')
      .replace(/[，,]/g, '');

    // 包含匹配
    if (normalizedFileName.includes(normalizedTitle) || normalizedTitle.includes(normalizedFileName)) {
      return { path: file.fullPath, name: file.relativePath };
    }
  }

  return null;
}

function extractWikilink(text) {
  const match = text.match(/\[\[(.*?)\]\]/);
  return match ? match[1] : null;
}

function fixBrokenLink(content, brokenLink, correctLink) {
  // 替换断链
  const pattern = new RegExp(`\\[\\[${brokenLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`, 'g');
  return content.replace(pattern, `[[${correctLink}]]`);
}

function processProject(project) {
  console.log(`\n处理项目: ${project.name}`);
  console.log('='.repeat(60));

  if (!fs.existsSync(project.lintFile)) {
    console.log(`  ❌ Lint 文件不存在: ${project.lintFile}`);
    return { fixed: 0, errors: 0 };
  }

  const lintData = JSON.parse(fs.readFileSync(project.lintFile, 'utf8'));
  const brokenLinks = lintData.filter(item => item.type === 'broken-link');

  console.log(`  📊 断链总数: ${brokenLinks.length}`);

  const fixes = [];
  const errors = [];

  for (const link of brokenLinks) {
    const target = extractWikilink(link.detail);
    if (!target) continue;

    // 尝试查找目标页面
    const found = findPageByTitle(project.wikiPath, target);

    if (found) {
      fixes.push({
        page: link.page,
        brokenLink: target,
        correctLink: found.name,
        targetPath: found.path
      });
    }
  }

  console.log(`  ✅ 可修复: ${fixes.length}`);

  if (fixes.length === 0) {
    return { fixed: 0, errors: 0 };
  }

  // 修复文件
  const processedFiles = new Set();

  for (const fix of fixes) {
    const pagePath = path.join(project.wikiPath, fix.page);

    try {
      let content = fs.readFileSync(pagePath, 'utf8');
      const originalContent = content;

      content = fixBrokenLink(content, fix.brokenLink, fix.correctLink);

      if (content !== originalContent) {
        fs.writeFileSync(pagePath, content, 'utf8');
        processedFiles.add(fix.page);
      }
    } catch (e) {
      errors.push({ page: fix.page, error: e.message });
    }
  }

  // 从 lint.json 中移除已修复的断链
  const updatedLintData = lintData.filter(item => {
    if (item.type !== 'broken-link') return true;

    const target = extractWikilink(item.detail);
    return !fixes.find(f => f.brokenLink === target);
  });

  fs.writeFileSync(project.lintFile, JSON.stringify(updatedLintData, null, 2), 'utf8');

  console.log(`  🔧 已修复文件: ${processedFiles.size}`);
  console.log(`  ❌ 修复失败: ${errors.length}`);

  if (errors.length > 0) {
    console.log(`  错误详情:`);
    errors.slice(0, 5).forEach(err => {
      console.log(`    - ${err.page}: ${err.error}`);
    });
  }

  return { fixed: processedFiles.size, errors: errors.length };
}

async function main() {
  console.log('🔧 LLM Wiki 断链自动修复工具');
  console.log('='.repeat(60));

  let totalFixed = 0;
  let totalErrors = 0;

  for (const project of projects) {
    const result = processProject(project);
    totalFixed += result.fixed;
    totalErrors += result.errors;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('📋 总结');
  console.log('='.repeat(60));
  console.log(`  ✅ 成功修复: ${totalFixed} 个文件`);
  console.log(`  ❌ 修复失败: ${totalErrors} 个`);

  console.log('\n💡 后续步骤:');
  console.log('1. 在应用中打开项目，查看修复后的 Lint 视图');
  console.log('2. 检查修复后的链接是否正确');
  console.log('3. 对于无法自动修复的断链，考虑手动处理或删除');
}

main().catch(console.error);
