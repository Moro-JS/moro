// Tests for package utility functions
import { describe, it, expect } from '@jest/globals';
import {
  filePathToImportURL,
  isPackageAvailable,
  resolveUserPackage,
} from '../../src/core/utilities/package-utils.js';
import { platform } from 'os';

describe('Package Utils', () => {
  describe('filePathToImportURL', () => {
    it('should convert Windows absolute paths to file URLs', () => {
      const windowsPath = 'C:\\Users\\project\\module.js';
      const result = filePathToImportURL(windowsPath);

      // Should start with file:///
      expect(result).toMatch(/^file:\/\/\//);

      // On Windows, it will properly convert. On Unix, it will treat it oddly,
      // but the important thing is it attempts URL conversion
      if (platform() === 'win32') {
        expect(result).toContain('Users/project/module.js');
      }
    });

    it('should convert Unix absolute paths to file URLs', () => {
      const unixPath = '/home/user/project/module.js';
      const result = filePathToImportURL(unixPath);

      // Should start with file:///
      expect(result).toMatch(/^file:\/\/\//);
      expect(result).toContain('home/user/project/module.js');
    });

    it('should handle relative paths as-is', () => {
      const relativePath = './module.js';
      const result = filePathToImportURL(relativePath);

      // Relative paths should remain unchanged
      expect(result).toBe('./module.js');
    });

    it('should handle relative paths with parent directories', () => {
      const relativePath = '../src/module.js';
      const result = filePathToImportURL(relativePath);

      // Relative paths should remain unchanged
      expect(result).toBe('../src/module.js');
    });

    it('should leave file:// URLs unchanged', () => {
      const fileURL = 'file:///C:/Users/project/module.js';
      const result = filePathToImportURL(fileURL);

      expect(result).toBe(fileURL);
    });

    it('should leave http:// URLs unchanged', () => {
      const httpURL = 'http://example.com/module.js';
      const result = filePathToImportURL(httpURL);

      expect(result).toBe(httpURL);
    });

    it('should leave https:// URLs unchanged', () => {
      const httpsURL = 'https://example.com/module.js';
      const result = filePathToImportURL(httpsURL);

      expect(result).toBe(httpsURL);
    });

    it('should handle empty string', () => {
      const emptyPath = '';
      const result = filePathToImportURL(emptyPath);

      expect(result).toBe('');
    });

    it('should handle Windows paths with forward slashes', () => {
      const windowsPath = 'C:/Users/project/module.js';
      const result = filePathToImportURL(windowsPath);

      // Should still convert to file URL
      expect(result).toMatch(/^file:\/\/\//);
    });

    it('should handle paths with spaces', () => {
      const pathWithSpaces = '/home/user/my project/module.js';
      const result = filePathToImportURL(pathWithSpaces);

      // Spaces should be URL-encoded
      expect(result).toMatch(/^file:\/\/\//);
      expect(result).toContain('my%20project');
    });

    it('should handle Windows UNC paths', () => {
      const uncPath = '\\\\server\\share\\module.js';
      const result = filePathToImportURL(uncPath);

      // UNC paths should be converted to file URL
      // On Windows this will work properly, on Unix it may not recognize it
      // but it should at least attempt conversion
      expect(result).toMatch(/^file:\/\//);
    });

    it('should identify and convert Windows drive letters correctly', () => {
      // Test various Windows drive letter formats
      const paths = [
        'C:\\path\\to\\file.js',
        'D:\\another\\path.js',
        'c:\\lowercase\\drive.js',
        'Z:\\last\\drive.js',
      ];

      paths.forEach(path => {
        const result = filePathToImportURL(path);
        expect(result).toMatch(/^file:\/\/\//);
      });
    });
  });

  describe('isPackageAvailable', () => {
    it('should return true for installed packages', () => {
      // Test with a package we know is installed
      expect(isPackageAvailable('path')).toBe(true);
    });

    it('should return false for non-existent packages', () => {
      expect(isPackageAvailable('this-package-does-not-exist-12345')).toBe(false);
    });
  });

  describe('resolveUserPackage', () => {
    it('should resolve installed packages', () => {
      // Test with a built-in module
      const result = resolveUserPackage('path');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should throw for non-existent packages', () => {
      expect(() => {
        resolveUserPackage('this-package-does-not-exist-12345');
      }).toThrow();
    });
  });
});
