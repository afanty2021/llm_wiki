#!/usr/bin/env node

/**
 * 分析并修复 LLM Wiki 项目中的断链问题
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
    lintFile: '/Users/berton/Documents/Invest/Invest/.llm-wiki/lint.json'
  },
  {
    name: 'English-Teaching',
    path: '/Users/berton/Documents/English-Teaching',
    lintFile: '/Users/berton/Documents/English-Teaching/.llm-wiki/lint.json'
  }
];

function extractWikilink(text) {
  const match = text.match(/\[\[(.*?)\]\]/);
  return match ? match[1] : null;
}

function findPageByTitle(wikiPath, title) {
  // 尝试不同的文件名模式
  const patterns = [
    `${title}.md`,
    `${title.toLowerCase()}.md`,
    `${title.replace(/\s+/g, '-')}.md`,
    `${title.replace(/\s+/g, '_')}.md`,
    `entities/${title}.md`,
    `concepts/${title}.md`,
    `sources/${title}.md`
  ];

  for (const pattern of patterns) {
    const filePath = path.join(wikiPath, pattern);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  // 模糊搜索
  const files = [];
  function searchDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        searchDir(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        const fileName = entry.name.replace('.md', '');
        if (fileName.toLowerCase().includes(title.toLowerCase().replace(/\s+/g, '-')) ||
            fileName.toLowerCase().includes(title.toLowerCase().replace(/\s+/g, '_'))) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }

  searchDir(wikiPath);
  return files[0] || null;
}

function analyzeProject(project) {
  console.log(`\n分析项目: ${project.name}`);
  console.log('='.repeat(60));

  if (!fs.existsSync(project.lintFile)) {
    console.log(`  ❌ Lint 文件不存在: ${project.lintFile}`);
    return;
  }

  const lintData = JSON.parse(fs.readFileSync(project.lintFile, 'utf8'));
  const brokenLinks = lintData.filter(item => item.type === 'broken-link');

  console.log(`  📊 断链总数: ${brokenLinks.length}`);

  const stats = {
    sourceFileLinks: 0,
    conceptLinks: 0,
    entityLinks: 0,
    found: 0,
    notFound: 0
  };

  const fixableLinks = [];
  const unfixableLinks = [];

  for (const link of brokenLinks) {
    const target = extractWikilink(link.detail);
    if (!target) continue;

    // 判断链接类型
    if (target.includes('.pdf') || target.includes('.docx') || target.includes('.pptx')) {
      stats.sourceFileLinks++;
    } else if (target.includes('(') || target.includes('（')) {
      stats.conceptLinks++;
    } else {
      stats.entityLinks++;
    }

    // 尝试查找目标页面
    const wikiPath = path.join(project.path, 'wiki');
    const foundPath = findPageByTitle(wikiPath, target);

    if (foundPath) {
      stats.found++;
      fixableLinks.push({
        page: link.page,
        link: target,
        found: foundPath
      });
    } else {
      stats.notFound++;
      unfixableLinks.push({
        page: link.page,
        link: target
      });
    }
  }

  console.log(`  🔍 链接类型分布:`);
  console.log(`    - 源文件链接: ${stats.sourceFileLinks}`);
  console.log(`    - 概念链接: ${stats.conceptLinks}`);
  console.log(`    - 实体链接: ${stats.entityLinks}`);

  console.log(`  ✅ 可修复: ${stats.found}`);
  console.log(`  ❌ 无法修复: ${stats.notFound}`);

  if (fixableLinks.length > 0) {
    console.log(`\n  📝 可修复链接示例 (前 5 个):`);
    fixableLinks.slice(0, 5).forEach(link => {
      console.log(`    - [[${link.link}]] → ${path.basename(link.found)}`);
    });
  }

  if (unfixableLinks.length > 0) {
    console.log(`\n  ⚠️  无法修复链接示例 (前 5 个):`);
    unfixableLinks.slice(0, 5).forEach(link => {
      console.log(`    - [[${link.link}]]`);
    });
  }

  return { stats, fixableLinks, unfixableLinks };
}

// 主函数
async function main() {
  console.log('🔍 LLM Wiki 断链分析工具');
  console.log('=' .repeat(60));

  const results = [];

  for (const project of projects) {
    const result = analyzeProject(project);
    results.push({ project, result });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('📋 总结');
  console.log('='.repeat(60));

  let totalFixable = 0;
  let totalUnfixable = 0;

  for (const { project, result } of results) {
    if (result) {
      console.log(`\n${project.name}:`);
      console.log(`  ✅ 可修复: ${result.stats.found}`);
      console.log(`  ❌ 无法修复: ${result.stats.notFound}`);
      totalFixable += result.stats.found;
      totalUnfixable += result.stats.notFound;
    }
  }

  console.log(`\n总计: ✅ ${totalFixable} | ❌ ${totalUnfixable}`);

  console.log('\n💡 修复建议:');
  console.log('1. 在应用中打开 Lint 视图');
  console.log('2. 使用"批量修复断链"功能');
  console.log('3. 对于无法修复的链接，建议删除或手动更新');
}

main().catch(console.error);
